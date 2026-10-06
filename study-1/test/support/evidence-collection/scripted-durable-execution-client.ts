// A real LambdaClient, built by the collector's production factory, over a scripted HTTP layer
// (design §12.2 `ScriptedDurableExecutionClient`). The SDK's restJson1 serializer, signer and error
// deserializer run; only the network is replaced by a model of durable executions. Listing honours
// `Qualifier`, `StartedAfter` and `Marker`; history pages by `Marker`; and a RUNNING execution ends
// only when StopDurableExecution stops it (RK-10), at the injected clock's instant. Timestamps go
// on the wire as epoch seconds, as the service writes them.

import { Readable } from 'node:stream';

import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createCollectorLambdaClient } from '../../../src/evidence-collection/aws/durable-execution-reader.ts';
import type { CollectorLambdaClientSettings } from '../../../src/evidence-collection/aws/durable-execution-reader.ts';
import type { JsonObject, JsonValue, WallClock } from '../../../src/record-contract/primitives.ts';

const API_PREFIX = '/2025-12-01/';

/** One modelled execution; `history` events are wire JSON (timestamps as epoch seconds). */
export interface ModelledDurableExecution {
  readonly arn: string;
  readonly name: string;
  readonly function_arn: string;
  readonly qualifier: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'STOPPED';
  readonly started_ms: number;
  ended_ms?: number;
  readonly version?: string;
  readonly history: readonly JsonObject[];
}

export interface RecordedLambdaCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[] | null>>;
}

/**
 * Production-built Lambda client over a durable-execution model.
 *
 * @example
 * const lambda = new ScriptedDurableExecutionClient(clock, 1);
 * lambda.addExecution({ arn, name, function_arn, qualifier: '3', status: 'RUNNING', started_ms, history: [] });
 * await createLambdaDurableExecutionReader(lambda.client).listPage(request);
 */
export class ScriptedDurableExecutionClient {
  readonly client: LambdaClient;
  readonly #executions: ModelledDurableExecution[] = [];
  readonly #errors: { readonly type: string; readonly status: number }[] = [];
  readonly #calls: RecordedLambdaCall[] = [];
  readonly #clock: WallClock;
  readonly #pageSize: number;

  constructor(clock: WallClock, pageSize = 100, settings: CollectorLambdaClientSettings = {}) {
    this.#clock = clock;
    this.#pageSize = pageSize;
    this.client = createCollectorLambdaClient({
      ...settings,
      credentials: { accessKeyId: 'AKIDSCRIPTEDLAMBDA', secretAccessKey: 'scripted-lambda-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
    });
  }

  addExecution(execution: ModelledDurableExecution): void {
    this.#executions.push({ ...execution });
  }

  /** The next request fails with this Lambda error type (HTTP 400 unless `status` says otherwise). */
  scriptError(type: string, status = 400): void {
    this.#errors.push({ type, status });
  }

  /** The current status of an execution, or undefined. */
  statusOf(arn: string): ModelledDurableExecution['status'] | undefined {
    return this.#executions.find((execution) => execution.arn === arn)?.status;
  }

  calls(): readonly RecordedLambdaCall[] {
    return [...this.#calls];
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    this.#calls.push({ method: request.method, path: request.path, query: { ...request.query } });
    const error = this.#errors.shift();
    if (error !== undefined) {
      return respond(error.status, { message: `scripted ${error.type}` }, error.type);
    }
    const segments = request.path.slice(API_PREFIX.length).split('/').map(decodeURIComponent);
    const [collection, id, action] = segments;
    if (collection === 'functions' && id !== undefined) {
      return respond(200, this.#list(id, request.query));
    }
    const execution = this.#executions.find((candidate) => candidate.arn === id);
    if (collection !== 'durable-executions' || execution === undefined) {
      return respond(404, { message: `no execution ${String(id)}` }, 'ResourceNotFoundException');
    }
    if (action === 'history') {
      return respond(200, this.#history(execution, request.query));
    }
    if (action === 'stop' && request.method === 'POST') {
      return respond(200, this.#stop(execution));
    }
    return respond(200, executionJson(execution));
  }

  #list(functionArn: string, query: HttpRequest['query']): JsonObject {
    const startedAfter = Date.parse(queryText(query, 'StartedAfter') ?? '1970-01-01T00:00:00Z');
    const matching = this.#executions.filter(
      (execution) =>
        execution.function_arn === functionArn &&
        execution.qualifier === (queryText(query, 'Qualifier') ?? execution.qualifier) &&
        execution.started_ms >= startedAfter,
    );
    const page = pageOf(matching, queryText(query, 'Marker'), this.#pageSize);
    return { DurableExecutions: page.items.map(executionJson), ...page.next };
  }

  #history(execution: ModelledDurableExecution, query: HttpRequest['query']): JsonObject {
    const page = pageOf(execution.history, queryText(query, 'Marker'), this.#pageSize);
    return { Events: [...page.items], ...page.next };
  }

  #stop(execution: ModelledDurableExecution): JsonObject {
    const stoppedMs = this.#clock.now().getTime();
    if (execution.status === 'RUNNING') {
      execution.status = 'STOPPED';
      execution.ended_ms = stoppedMs;
    }
    return { StopTimestamp: stoppedMs / 1000 };
  }
}

function executionJson(execution: ModelledDurableExecution): JsonObject {
  return {
    DurableExecutionArn: execution.arn,
    DurableExecutionName: execution.name,
    FunctionArn: execution.function_arn,
    Status: execution.status,
    StartTimestamp: execution.started_ms / 1000,
    ...(execution.ended_ms === undefined ? {} : { EndTimestamp: execution.ended_ms / 1000 }),
    ...(execution.version === undefined ? {} : { Version: execution.version }),
  };
}

function pageOf<T>(
  all: readonly T[],
  marker: string | undefined,
  pageSize: number,
): { readonly items: readonly T[]; readonly next: { readonly NextMarker?: string } } {
  const start = marker === undefined ? 0 : Number(marker);
  const end = start + pageSize;
  return { items: all.slice(start, end), next: end < all.length ? { NextMarker: String(end) } : {} };
}

function queryText(query: HttpRequest['query'], name: string): string | undefined {
  const value = query?.[name];
  return typeof value === 'string' ? value : undefined;
}

function respond(status: number, body: JsonValue, errorType?: string): Promise<{ response: HttpResponse }> {
  return Promise.resolve({
    response: {
      statusCode: status,
      headers: {
        'content-type': 'application/json',
        ...(errorType === undefined ? {} : { 'x-amzn-errortype': errorType }),
      },
      body: Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    },
  });
}
