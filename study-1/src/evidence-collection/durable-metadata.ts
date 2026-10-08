// Durable execution metadata (design §5.3 `DurableExecutionReader`, `buildDurableExecutionMetadata`;
// §7 `execution-metadata/durable-executions.json`; BR-RUA-020, BR-RUA-037, RK-10). For a Durable
// trial the collector lists every execution of the caller's published version started at or after
// the trial publication (`StartedAfter`), reads each execution, and pages its history. Each read is
// a single page of the service so the paging decisions live here, not in the adapter:
// - the listing pages until there is no `NextMarker`; a failed page or a repeated marker leaves
//   `list_complete` false;
// - a failed GetDurableExecution keeps the listed summary (without a version) and records why;
// - each history pages the same way, and an incomplete history leaves `history_complete` false.
// A malformed execution or event is recorded as a failure and left out, and the flag of the read it
// belongs to turns false, so the record never claims completeness it does not have.

import { pushEach } from '../durable-store/push-each.ts';
import { ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type {
  DurableExecutionRecord,
  DurableHistoryEvent,
} from '../record-contract/records/group-b/durable_execution_metadata.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { correlationFields } from './capture-scope.ts';
import type { TrialCaptureScope } from './capture-scope.ts';
import { readFailure } from './collected-records.ts';
import type { CollectorReadFailure } from './collected-records.ts';
import { mapDurableExecution, mapHistoryEvent } from './durable-sdk-mapping.ts';
import type { DurableExecutionSummary, SdkDurableExecution, SdkHistoryEvent } from './durable-sdk-mapping.ts';
import { quoted } from './sdk-values.ts';

/** Which executions to list: the caller function, its published version and the publication instant. */
export interface DurableListingRequest {
  readonly function_arn: string;
  readonly qualifier: string;
  readonly started_after: UtcMillis;
}

/** One page of ListDurableExecutionsByFunction. */
export interface SdkDurableListPage {
  readonly DurableExecutions?: readonly SdkDurableExecution[] | undefined;
  readonly NextMarker?: string | undefined;
}

/** One page of GetDurableExecutionHistory. */
export interface SdkHistoryPage {
  readonly Events?: readonly SdkHistoryEvent[] | undefined;
  readonly NextMarker?: string | undefined;
}

/** The three Lambda reads, one service page per call (design §5.3). */
export interface DurableExecutionReader {
  listPage(request: DurableListingRequest, marker?: string): Promise<Result<SdkDurableListPage, CollectorReadFailure>>;
  getExecution(arn: string): Promise<Result<SdkDurableExecution, CollectorReadFailure>>;
  historyPage(arn: string, marker?: string): Promise<Result<SdkHistoryPage, CollectorReadFailure>>;
}

/** Every listed execution and whether the listing finished. */
export interface DurableListing {
  readonly executions: readonly DurableExecutionSummary[];
  readonly complete: boolean;
  readonly failures: readonly StructuredReason[];
}

/** The metadata record and what settlement and cleanup read from it. */
export interface DurableMetadataCapture {
  readonly record: JsonObject;
  /** True when the listing finished and no listed execution is RUNNING (§8.12). */
  readonly inner_executions_terminal: boolean;
  readonly failures: readonly StructuredReason[];
}

/** The inputs of the pure record builder. */
export interface DurableMetadataInput {
  readonly scope: TrialCaptureScope;
  readonly request: DurableListingRequest;
  readonly captured_at: UtcMillis;
  readonly list_complete: boolean;
  readonly executions: readonly DurableExecutionRecord[];
}

interface PagedRead<T> {
  readonly items: readonly T[];
  readonly complete: boolean;
  readonly failures: readonly StructuredReason[];
}

type PageFetch<T> = (
  marker: string | undefined,
) => Promise<
  Result<{ readonly raw: readonly T[] | undefined; readonly next?: string | undefined }, CollectorReadFailure>
>;

/**
 * Lists the executions of the caller version started after publication, every page.
 *
 * @example
 * const listing = await listDurableExecutions(reader, request);
 * listing.executions.filter((execution) => execution.status === 'RUNNING');
 */
export async function listDurableExecutions(
  reader: DurableExecutionReader,
  request: DurableListingRequest,
): Promise<DurableListing> {
  const read = await readPages<SdkDurableExecution, DurableExecutionSummary>(
    `durable listing of ${request.function_arn}:${request.qualifier}`,
    async (marker) => {
      const page = await reader.listPage(request, marker);
      return page.ok ? ok({ raw: page.value.DurableExecutions, next: page.value.NextMarker }) : page;
    },
    mapDurableExecution,
  );
  return { executions: read.items, complete: read.complete, failures: read.failures };
}

/**
 * Whether every inner execution has ended: the listing finished and none is RUNNING (§8.12).
 *
 * @example
 * innerExecutionsTerminal(listing); // false while an execution is RUNNING or the listing is incomplete
 */
export function innerExecutionsTerminal(listing: Pick<DurableListing, 'executions' | 'complete'>): boolean {
  return listing.complete && listing.executions.every((execution) => execution.status !== 'RUNNING');
}

/**
 * Collects the `durable_execution_metadata` record: the listing, each execution and its history.
 *
 * @example
 * const metadata = await collectDurableExecutionMetadata(reader, request, scope, clock);
 * metadata.record['list_complete']; // true when every listing page was read
 */
export async function collectDurableExecutionMetadata(
  reader: DurableExecutionReader,
  request: DurableListingRequest,
  scope: TrialCaptureScope,
  clock: WallClock,
): Promise<DurableMetadataCapture> {
  const listing = await listDurableExecutions(reader, request);
  const failures: StructuredReason[] = [];
  pushEach(failures, listing.failures);
  const executions: DurableExecutionRecord[] = [];
  for (const summary of listing.executions) {
    const detailed = await readExecution(reader, summary, failures);
    const history = await readHistory(reader, summary.durable_execution_arn);
    pushEach(failures, history.failures);
    executions.push({ ...detailed, history_complete: history.complete, history: history.items });
  }
  const record = buildDurableExecutionMetadata({
    scope,
    request,
    captured_at: formatUtcMillis(clock.now()),
    list_complete: listing.complete,
    executions,
  });
  const terminal = innerExecutionsTerminal({ executions, complete: listing.complete });
  return { record, inner_executions_terminal: terminal, failures };
}

/**
 * Builds the `durable_execution_metadata` record (catalogue row 62) from what was read.
 *
 * @example
 * buildDurableExecutionMetadata({ scope, request, captured_at, list_complete: true, executions: [] })['record_type'];
 * // 'durable_execution_metadata'
 */
export function buildDurableExecutionMetadata(input: DurableMetadataInput): JsonObject {
  return {
    schema_version: 1,
    record_type: 'durable_execution_metadata',
    ...correlationFields(input.scope),
    function_arn: input.request.function_arn,
    qualifier: input.request.qualifier,
    captured_at: input.captured_at,
    started_after: input.request.started_after,
    list_complete: input.list_complete,
    executions: input.executions.map((execution) => ({
      ...execution,
      history: execution.history.map((event) => ({ ...event })),
    })),
  };
}

// GetDurableExecution adds the version and the latest status; on failure the listed summary stands.
async function readExecution(
  reader: DurableExecutionReader,
  summary: DurableExecutionSummary,
  failures: StructuredReason[],
): Promise<DurableExecutionSummary> {
  const arn = summary.durable_execution_arn;
  const read = await reader.getExecution(arn);
  if (!read.ok) {
    failures.push(readFailure('DURABLE_EXECUTION_READ_FAILED', 'durable execution', arn, read.error));
    return summary;
  }
  const mapped = mapDurableExecution(read.value);
  if (!mapped.ok) {
    failures.push(malformedResponse(`durable execution ${arn}`, mapped.error));
    return summary;
  }
  return mapped.value;
}

async function readHistory(reader: DurableExecutionReader, arn: string): Promise<PagedRead<DurableHistoryEvent>> {
  return readPages<SdkHistoryEvent, DurableHistoryEvent>(
    `durable history of ${arn}`,
    async (marker) => {
      const page = await reader.historyPage(arn, marker);
      return page.ok ? ok({ raw: page.value.Events, next: page.value.NextMarker }) : page;
    },
    mapHistoryEvent,
  );
}

async function readPages<Raw, Mapped>(
  target: string,
  fetchPage: PageFetch<Raw>,
  map: (raw: Raw) => Result<Mapped, string>,
): Promise<PagedRead<Mapped>> {
  const items: Mapped[] = [];
  const failures: StructuredReason[] = [];
  const seen = new Set<string>();
  let marker: string | undefined;
  let pageNumber = 0;
  for (;;) {
    pageNumber += 1;
    const page = await fetchPage(marker);
    if (!page.ok) {
      failures.push(readFailure('DURABLE_PAGE_READ_FAILED', 'lambda', target, page.error, pageNumber));
      return { items, complete: false, failures };
    }
    keepMapped(page.value.raw ?? [], map, { items, failures, target });
    marker = page.value.next;
    if (marker === undefined) {
      return { items, complete: failures.length === 0, failures };
    }
    if (seen.has(marker)) {
      failures.push(malformedResponse(target, `marker ${quoted(marker)} repeated after page ${String(pageNumber)}`));
      return { items, complete: false, failures };
    }
    seen.add(marker);
  }
}

// Maps each raw element; a malformed one becomes a failure, never an item.
function keepMapped<Raw, Mapped>(
  raws: readonly Raw[],
  map: (raw: Raw) => Result<Mapped, string>,
  into: { readonly items: Mapped[]; readonly failures: StructuredReason[]; readonly target: string },
): void {
  for (const raw of raws) {
    const mapped = map(raw);
    if (mapped.ok) {
      into.items.push(mapped.value);
      continue;
    }
    into.failures.push(malformedResponse(into.target, mapped.error));
  }
}

function malformedResponse(target: string, problem: string): StructuredReason {
  return {
    code: 'DURABLE_RESPONSE_MALFORMED',
    subject: 'BR-RUA-037',
    detail: `${target}: ${problem}; expected the Lambda durable-execution response shape`,
  };
}
