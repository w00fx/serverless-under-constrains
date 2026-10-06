// A named fake of the collector's `DurableExecutionReader` port (design §5.3, §12.2): executions
// of one function version with their histories, served one page at a time like the Lambda API.
// Entries are kept raw, so a test can serve malformed or hostile members. Scripted failures answer
// the next call of one operation, and a scripted repeated marker makes the next page point back at
// itself (a broken endpoint the collector must not loop on).

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type {
  DurableExecutionReader,
  DurableListingRequest,
  SdkDurableListPage,
  SdkHistoryPage,
} from '../../../src/evidence-collection/durable-metadata.ts';
import type { SdkDurableExecution, SdkHistoryEvent } from '../../../src/evidence-collection/durable-sdk-mapping.ts';

export type DurableReadOperation = 'listPage' | 'getExecution' | 'historyPage';

interface ScriptedExecution {
  readonly listed: SdkDurableExecution;
  readonly detail: SdkDurableExecution;
  readonly history: readonly SdkHistoryEvent[];
}

/**
 * Durable executions served in pages of `pageSize`, with one-shot failures per operation.
 *
 * @example
 * const durable = new ScriptedDurableExecutionReader(2);
 * durable.addExecution(sdkExecution({ status: 'SUCCEEDED' }), [sdkEvent('ExecutionStarted')]);
 * durable.scriptFailure('historyPage', 'ThrottlingException');
 */
export class ScriptedDurableExecutionReader implements DurableExecutionReader {
  readonly #executions: ScriptedExecution[] = [];
  readonly #failures = new Map<DurableReadOperation, string[]>();
  readonly #repeatedMarkers = new Set<DurableReadOperation>();
  readonly #requests: DurableListingRequest[] = [];
  readonly #pageSize: number;

  constructor(pageSize = 100) {
    this.#pageSize = pageSize;
  }

  /** Adds an execution; `detail` is what GetDurableExecution returns (the listed entry by default). */
  addExecution(listed: SdkDurableExecution, history: readonly SdkHistoryEvent[], detail = listed): void {
    this.#executions.push({ listed, detail, history });
  }

  /** The next call of `operation` fails with `code`; failures queue in order. */
  scriptFailure(operation: DurableReadOperation, code: string): void {
    this.#failures.set(operation, [...(this.#failures.get(operation) ?? []), code]);
  }

  /** Every page of `operation` returns the same marker it was asked with (or `loop` on the first). */
  scriptRepeatedMarker(operation: 'listPage' | 'historyPage'): void {
    this.#repeatedMarkers.add(operation);
  }

  /** Every listing request, in order. */
  listingRequests(): readonly DurableListingRequest[] {
    return [...this.#requests];
  }

  listPage(request: DurableListingRequest, marker?: string): Promise<Result<SdkDurableListPage, CollectorReadFailure>> {
    this.#requests.push(request);
    const failed = this.#takeFailure('listPage');
    if (failed !== undefined) {
      return Promise.resolve(failed);
    }
    const page = this.#page(
      'listPage',
      this.#executions.map((execution) => execution.listed),
      marker,
    );
    // Like the service's JSON, an empty page omits its list member, which the SDK leaves undefined.
    const executions = page.items.length === 0 ? {} : { DurableExecutions: page.items };
    return Promise.resolve({ ok: true, value: { ...executions, NextMarker: page.next } });
  }

  getExecution(arn: string): Promise<Result<SdkDurableExecution, CollectorReadFailure>> {
    const failed = this.#takeFailure('getExecution');
    if (failed !== undefined) {
      return Promise.resolve(failed);
    }
    const execution = this.#find(arn);
    return Promise.resolve(
      execution === undefined
        ? { ok: false, error: { code: 'ResourceNotFoundException' } }
        : { ok: true, value: execution.detail },
    );
  }

  historyPage(arn: string, marker?: string): Promise<Result<SdkHistoryPage, CollectorReadFailure>> {
    const failed = this.#takeFailure('historyPage');
    if (failed !== undefined) {
      return Promise.resolve(failed);
    }
    const execution = this.#find(arn);
    if (execution === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'ResourceNotFoundException' } });
    }
    const page = this.#page('historyPage', execution.history, marker);
    const events = page.items.length === 0 ? {} : { Events: page.items };
    return Promise.resolve({ ok: true, value: { ...events, NextMarker: page.next } });
  }

  #find(arn: string): ScriptedExecution | undefined {
    return this.#executions.find((execution) => execution.listed.DurableExecutionArn === arn);
  }

  #takeFailure(
    operation: DurableReadOperation,
  ): { readonly ok: false; readonly error: CollectorReadFailure } | undefined {
    const code = this.#failures.get(operation)?.shift();
    return code === undefined ? undefined : { ok: false, error: { code } };
  }

  // Markers are the decimal offset of the next page, as opaque to the collector as the service's.
  #page<T>(
    operation: DurableReadOperation,
    all: readonly T[],
    marker: string | undefined,
  ): { readonly items: readonly T[]; readonly next: string | undefined } {
    if (this.#repeatedMarkers.has(operation)) {
      return { items: all.slice(0, this.#pageSize), next: marker ?? 'loop' };
    }
    const start = marker === undefined ? 0 : Number(marker);
    const end = start + this.#pageSize;
    return { items: all.slice(start, end), next: end < all.length ? String(end) : undefined };
  }
}
