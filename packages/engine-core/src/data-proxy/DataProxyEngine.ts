import Debug from '@prisma/debug'
import { DMMF } from '@prisma/generator-helper'

import type {
  BatchQueryEngineResult,
  EngineConfig,
  EngineEventType,
  EngineQuery,
  GetConfigResult,
  InlineDatasource,
  InteractiveTransactionOptions,
  RequestBatchOptions,
  RequestOptions,
} from '../common/Engine'
import { Engine } from '../common/Engine'
import { PrismaClientUnknownRequestError } from '../common/errors/PrismaClientUnknownRequestError'
import { LogLevel } from '../common/errors/utils/log'
import { prismaGraphQLToJSError } from '../common/errors/utils/prismaGraphQLToJSError'
import { EventEmitter } from '../common/types/Events'
import { EngineMetricsOptions, Metrics, MetricsOptionsJson, MetricsOptionsPrometheus } from '../common/types/Metrics'
import { EngineSpan, QueryEngineResult, QueryEngineResultBatchQueryResult } from '../common/types/QueryEngine'
import type * as Tx from '../common/types/Transaction'
import { getBatchRequestPayload } from '../common/utils/getBatchRequestPayload'
import { createSpan, getTraceParent, getTracingConfig, TracingConfig } from '../tracing'
import { DataProxyError } from './errors/DataProxyError'
import { ForcedRetryError } from './errors/ForcedRetryError'
import { InvalidDatasourceError } from './errors/InvalidDatasourceError'
import { NotImplementedYetError } from './errors/NotImplementedYetError'
import { SchemaMissingError } from './errors/SchemaMissingError'
import { responseToError } from './errors/utils/responseToError'
import { backOff } from './utils/backOff'
import { getClientVersion } from './utils/getClientVersion'
import { request } from './utils/request'

const MAX_RETRIES = 10

// to defer the execution of promises in the constructor
const P = Promise.resolve()

const debug = Debug('prisma:client:dataproxyEngine')

type DataProxyTxInfoPayload = {
  endpoint: string
}

type DataProxyTxInfo = Tx.InteractiveTransactionInfo<DataProxyTxInfoPayload>

type RequestInternalOptions = {
  body: Record<string, unknown>
  customHeaders?: Record<string, string>
  traceparent?: string
  interactiveTransaction?: InteractiveTransactionOptions<DataProxyTxInfoPayload>
}

type DataProxyLog = {
  span_id: string
  name: string
  level: LogLevel
  timestamp: [number, number]
  attributes: Record<string, unknown> & { duration_ms: number }
}

type DataProxyExtensions = {
  logs?: DataProxyLog[]
  traces?: EngineSpan[]
}

type DataProxyHeaders = {
  Authorization: string
  'X-capture-telemetry'?: string
  traceparent?: string
}

class DataProxyHeaderBuilder {
  readonly apiKey: string
  readonly tracingConfig: TracingConfig
  readonly logLevel: EngineConfig['logLevel']
  readonly logQueries: boolean | undefined
  readonly engine: DataProxyEngine

  constructor({
    apiKey,
    tracingConfig,
    logLevel,
    logQueries,
    engine,
  }: {
    apiKey: string
    tracingConfig: TracingConfig
    logLevel: EngineConfig['logLevel']
    logQueries: boolean | undefined
    engine: DataProxyEngine
  }) {
    this.apiKey = apiKey
    this.tracingConfig = tracingConfig
    this.logLevel = logLevel
    this.logQueries = logQueries
    this.engine = engine
  }

  build({ existingHeaders = {} }: { existingHeaders?: Record<string, string | undefined> } = {}): DataProxyHeaders {
    const values: string[] = []

    if (this.tracingConfig.enabled) {
      values.push('tracing')
    }

    if (this.logLevel) {
      values.push(this.logLevel)
    }

    if (this.logQueries) {
      values.push('query')
    }

    const headers: DataProxyHeaders = {
      ...existingHeaders,
      Authorization: `Bearer ${this.apiKey}`,
      'X-capture-telemetry': values.join(','),
    }

    if (this.tracingConfig.enabled) {
      headers.traceparent ??= getTraceParent({})
    } else {
      delete headers.traceparent
    }

    this.engine.setHeaders(headers)

    return headers
  }
}

export class DataProxyEngine extends Engine<DataProxyTxInfoPayload> {
  private inlineSchema: string
  readonly inlineSchemaHash: string
  private inlineDatasources: Record<string, InlineDatasource>
  private config: EngineConfig
  private logEmitter: EventEmitter
  private env: { [k in string]?: string }

  private clientVersion: string
  readonly remoteClientVersion: Promise<string>
  readonly host: string
  readonly headerBuilder: DataProxyHeaderBuilder
  public headers: DataProxyHeaders

  constructor(config: EngineConfig) {
    super()

    this.config = config
    this.env = { ...this.config.env, ...process.env }
    this.inlineSchema = config.inlineSchema ?? ''
    this.inlineDatasources = config.inlineDatasources ?? {}
    this.inlineSchemaHash = config.inlineSchemaHash ?? ''
    this.clientVersion = config.clientVersion ?? 'unknown'
    this.logEmitter = config.logEmitter

    const [host, apiKey] = this.extractHostAndApiKey()
    this.host = host

    this.headerBuilder = new DataProxyHeaderBuilder({
      apiKey,
      tracingConfig: getTracingConfig(this.config.previewFeatures || []),
      logLevel: config.logLevel,
      logQueries: config.logQueries,
      engine: this,
    })

    this.headers = this.headerBuilder.build()

    this.remoteClientVersion = P.then(() => getClientVersion(this.config))

    debug('host', this.host)
  }

  version() {
    // QE is remote, we don't need to know the exact commit SHA
    return 'unknown'
  }

  setHeaders(headers: DataProxyHeaders) {
    this.headers = headers
  }

  async start() {}
  async stop() {}

  private propagateResponseExtensions(extensions: DataProxyExtensions): void {
    const tracingConfig = getTracingConfig(this.config.previewFeatures || [])

    if (extensions?.logs?.length) {
      extensions.logs.forEach((log) => {
        switch (log.level) {
          case 'debug':
          case 'error':
          case 'trace':
          case 'warn':
          case 'info':
            // TODO these are propgated into the response.errors key
            break
          case 'query': {
            let dbQuery = log.attributes?.query || log.name
            if (!tracingConfig.enabled) {
              // The engine uses tracing to consolidate logs
              //  - and so we should strip the generated traceparent
              //  - if tracing is disabled.
              // Example query: 'SELECT /* traceparent=00-123-0-01 */'
              const [query] = dbQuery.split('/* traceparent')
              dbQuery = query
            }

            this.logEmitter.emit('query', {
              query: dbQuery,
              timestamp: log.timestamp,
              duration: log.attributes.duration_ms,
              // params: log.params - Missing
              // target: log.target - Missing
            })
          }
        }
      })
    }

    if (extensions?.traces?.length && tracingConfig.enabled) {
      void createSpan({ span: true, spans: extensions.traces })
    }
  }

  on(event: EngineEventType, listener: (args?: any) => any): void {
    if (event === 'beforeExit') {
      // TODO: hook into the process
      throw new NotImplementedYetError('beforeExit event is not yet supported', {
        clientVersion: this.clientVersion,
      })
    } else {
      this.logEmitter.on(event, listener)
    }
  }

  private async url(s: string) {
    return `https://${this.host}/${await this.remoteClientVersion}/${this.inlineSchemaHash}/${s}`
  }

  getDmmf(): Promise<DMMF.Document> {
    // This code path should not be reachable, as it is handled upstream in `getPrismaClient`.
    throw new NotImplementedYetError('getDmmf is not yet supported', {
      clientVersion: this.clientVersion,
    })
  }

  private async uploadSchema() {
    const response = await request(await this.url('schema'), {
      method: 'PUT',
      headers: this.headerBuilder.build(),
      body: this.inlineSchema,
      clientVersion: this.clientVersion,
    })

    if (!response.ok) {
      debug('schema response status', response.status)
    }

    const err = await responseToError(response, this.clientVersion)

    if (err) {
      this.logEmitter.emit('warn', { message: `Error while uploading schema: ${err.message}` })
      throw err
    } else {
      this.logEmitter.emit('info', {
        message: `Schema (re)uploaded (hash: ${this.inlineSchemaHash})`,
      })
    }
  }

  request<T>(
    { query }: EngineQuery,
    { traceparent, interactiveTransaction, customDataProxyHeaders }: RequestOptions<DataProxyTxInfoPayload>,
  ) {
    // TODO: `elapsed`?
    return this.requestInternal<T>({
      body: { query, variables: {} },
      traceparent,
      interactiveTransaction,
      customHeaders: customDataProxyHeaders,
    })
  }

  async requestBatch<T>(
    queries: EngineQuery[],
    { traceparent, transaction, customDataProxyHeaders }: RequestBatchOptions<DataProxyTxInfoPayload>,
  ): Promise<BatchQueryEngineResult<T>[]> {
    const isTransaction = Boolean(transaction)

    const interactiveTransaction = transaction?.kind === 'itx' ? transaction.options : undefined

    const body = getBatchRequestPayload(queries, transaction)

    const { batchResult, elapsed } = await this.requestInternal<T, true>({
      body,
      customHeaders: customDataProxyHeaders,
      interactiveTransaction,
      traceparent,
    })

    return batchResult.map((result) => {
      if ('errors' in result && result.errors.length > 0) {
        return prismaGraphQLToJSError(result.errors[0], this.clientVersion!)
      }
      return {
        data: result as T,
        elapsed,
      }
    })
  }

  private requestInternal<T, Batch extends boolean = false>({
    body,
    traceparent,
    customHeaders,
    interactiveTransaction,
  }: RequestInternalOptions): Promise<
    Batch extends true ? { batchResult: QueryEngineResultBatchQueryResult<T>[]; elapsed: number } : QueryEngineResult<T>
  > {
    return this.withRetry({
      actionGerund: 'querying',
      callback: async ({ logHttpCall }) => {
        const url = interactiveTransaction
          ? `${interactiveTransaction.payload.endpoint}/graphql`
          : await this.url('graphql')

        logHttpCall(url)

        const headers: Record<string, string> = { ...customHeaders }
        if (traceparent) {
          headers.traceparent = traceparent
        }

        if (interactiveTransaction) {
          headers['X-transaction-id'] = interactiveTransaction.id
        }

        const response = await request(url, {
          method: 'POST',
          headers: this.headerBuilder.build({ existingHeaders: headers }),
          body: JSON.stringify(body),
          clientVersion: this.clientVersion,
        })

        if (!response.ok) {
          debug('graphql response status', response.status)
        }

        const e = await responseToError(response, this.clientVersion)
        await this.handleError(e)

        const data = await response.json()
        const extensions = data.extensions as DataProxyExtensions | undefined
        if (extensions) {
          this.propagateResponseExtensions(extensions)
        }

        // TODO: headers contain `x-elapsed` and it needs to be returned

        if (data.errors) {
          if (data.errors.length === 1) {
            throw prismaGraphQLToJSError(data.errors[0], this.config.clientVersion!)
          } else {
            throw new PrismaClientUnknownRequestError(data.errors, { clientVersion: this.config.clientVersion! })
          }
        }

        return data
      },
    })
  }

  /**
   * Send START, COMMIT, or ROLLBACK to the Query Engine
   * @param action START, COMMIT, or ROLLBACK
   * @param headers headers for tracing
   * @param options to change the default timeouts
   * @param info transaction information for the QE
   */
  transaction(action: 'start', headers: Tx.TransactionHeaders, options?: Tx.Options): Promise<DataProxyTxInfo>
  transaction(action: 'commit', headers: Tx.TransactionHeaders, info: DataProxyTxInfo): Promise<undefined>
  transaction(action: 'rollback', headers: Tx.TransactionHeaders, info: DataProxyTxInfo): Promise<undefined>
  async transaction(action: any, headers: Tx.TransactionHeaders, arg?: any) {
    const actionToGerund = {
      start: 'starting',
      commit: 'committing',
      rollback: 'rolling back',
    }

    return this.withRetry({
      actionGerund: `${actionToGerund[action]} transaction`,
      callback: async ({ logHttpCall }) => {
        if (action === 'start') {
          const body = JSON.stringify({
            max_wait: arg?.maxWait ?? 2000, // default
            timeout: arg?.timeout ?? 5000, // default
            isolation_level: arg?.isolationLevel,
          })

          const url = await this.url('transaction/start')

          logHttpCall(url)

          const response = await request(url, {
            method: 'POST',
            headers: this.headerBuilder.build({ existingHeaders: headers }),
            body,
            clientVersion: this.clientVersion,
          })

          const err = await responseToError(response, this.clientVersion)
          await this.handleError(err)

          const json = await response.json()

          const extensions = json.extensions as DataProxyExtensions | undefined
          if (extensions) {
            this.propagateResponseExtensions(extensions)
          }

          const id = json.id as string
          const endpoint = json['data-proxy'].endpoint as string

          return { id, payload: { endpoint } }
        } else {
          const url = `${arg.payload.endpoint}/${action}`

          logHttpCall(url)

          const response = await request(url, {
            method: 'POST',
            headers: this.headerBuilder.build({ existingHeaders: headers }),
            clientVersion: this.clientVersion,
          })

          const json = await response.json()
          const extensions = json.extensions as DataProxyExtensions | undefined
          if (extensions) {
            this.propagateResponseExtensions(extensions)
          }

          const err = await responseToError(response, this.clientVersion)
          await this.handleError(err)

          return undefined
        }
      },
    })
  }

  private extractHostAndApiKey() {
    const datasources = this.mergeOverriddenDatasources()
    const mainDatasourceName = Object.keys(datasources)[0]
    const mainDatasource = datasources[mainDatasourceName]
    const dataProxyURL = this.resolveDatasourceURL(mainDatasourceName, mainDatasource)

    let url: URL
    try {
      url = new URL(dataProxyURL)
    } catch {
      throw new InvalidDatasourceError('Could not parse URL of the datasource', {
        clientVersion: this.clientVersion,
      })
    }

    const { protocol, host, searchParams } = url

    if (protocol !== 'prisma:') {
      throw new InvalidDatasourceError('Datasource URL must use prisma:// protocol when --data-proxy is used', {
        clientVersion: this.clientVersion,
      })
    }

    const apiKey = searchParams.get('api_key')
    if (apiKey === null || apiKey.length < 1) {
      throw new InvalidDatasourceError('No valid API key found in the datasource URL', {
        clientVersion: this.clientVersion,
      })
    }

    return [host, apiKey]
  }

  private mergeOverriddenDatasources(): Record<string, InlineDatasource> {
    if (this.config.datasources === undefined) {
      return this.inlineDatasources
    }

    const finalDatasources = { ...this.inlineDatasources }

    for (const override of this.config.datasources) {
      if (!this.inlineDatasources[override.name]) {
        throw new Error(`Unknown datasource: ${override.name}`)
      }

      finalDatasources[override.name] = {
        url: {
          fromEnvVar: null,
          value: override.url,
        },
      }
    }

    return finalDatasources
  }

  private resolveDatasourceURL(name: string, datasource: InlineDatasource): string {
    if (datasource.url.value) {
      return datasource.url.value
    }

    if (datasource.url.fromEnvVar) {
      const envVar = datasource.url.fromEnvVar
      const loadedEnvURL = this.env[envVar]

      if (loadedEnvURL === undefined) {
        throw new InvalidDatasourceError(
          `Datasource "${name}" references an environment variable "${envVar}" that is not set`,
          {
            clientVersion: this.clientVersion,
          },
        )
      }

      return loadedEnvURL
    }

    throw new InvalidDatasourceError(
      `Datasource "${name}" specification is invalid: both value and fromEnvVar are null`,
      {
        clientVersion: this.clientVersion,
      },
    )
  }

  metrics(options: MetricsOptionsJson): Promise<Metrics>
  metrics(options: MetricsOptionsPrometheus): Promise<string>
  metrics(options: EngineMetricsOptions): Promise<Metrics> | Promise<string> {
    throw new NotImplementedYetError('Metric are not yet supported for Data Proxy', {
      clientVersion: this.clientVersion,
    })
  }

  private async withRetry<T>(args: {
    callback: (api: { logHttpCall: (url: string) => void }) => Promise<T>
    actionGerund: string
  }): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const logHttpCall = (url: string) => {
        this.logEmitter.emit('info', {
          message: `Calling ${url} (n=${attempt})`,
        })
      }

      try {
        return await args.callback({ logHttpCall })
      } catch (e) {
        if (!(e instanceof DataProxyError)) throw e
        if (!e.isRetryable) throw e
        if (attempt >= MAX_RETRIES) {
          if (e instanceof ForcedRetryError) {
            throw e.cause
          } else {
            throw e
          }
        }

        this.logEmitter.emit('warn', {
          message: `Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${args.actionGerund}: ${e.message ?? '(unknown)'}`,
        })
        const delay = await backOff(attempt)
        this.logEmitter.emit('warn', { message: `Retrying after ${delay}ms` })
      }
    }
  }

  private async handleError(error: DataProxyError | undefined): Promise<void> {
    if (error instanceof SchemaMissingError) {
      await this.uploadSchema()
      throw new ForcedRetryError({
        clientVersion: this.clientVersion,
        cause: error,
      })
    } else if (error) {
      throw error
    }
  }
}
