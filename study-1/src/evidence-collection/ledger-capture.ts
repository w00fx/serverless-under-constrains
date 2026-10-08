// The independent ledger read (BR-RUA-005, BR-RUA-032, BR-RUA-034; design §5.3
// `captureLedgerSnapshot`, §9.3 "collector: Query pk, ConsistentRead: true, paged until there is
// no LastEvaluatedKey"). The collector, never a variant role, reads the trial's ledger partition
// with strongly consistent pages until the store returns no cursor, and records every page with
// the cursors that bound it. It never truncates: every item read is kept, whatever the expected
// size (BR-RUA-034 "Evidence collection never truncates a ledger because of an expected size").
//
// A read that cannot finish is recorded as it happened, never padded or dropped: `complete` is
// false and the last recorded page still carries the cursor of the page that failed, so ingestion
// classifies LEDGER_PAGINATION_INCOMPLETE and the ledger-access gate is unverified (AC-RUA-007
// case 1). Items are copied without their table key; an item that is not a well-formed
// transaction stays in the snapshot for ingestion to judge (RECORD_SCHEMA_INVALID), because
// dropping it would be truncation.

import type { StoredItem } from '../durable-store/item-store-port.ts';
import { pushEach } from '../durable-store/push-each.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { JsonObject, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import { capturePartitionKey, correlationFields } from './capture-scope.ts';
import type { CaptureScope } from './capture-scope.ts';
import { readFailure, recordOfItem } from './collected-records.ts';
import type { CollectorStoreReader } from './collected-records.ts';

/** The ledger read and what settlement needs to know about it. */
export interface LedgerCapture {
  /** The `ledger_snapshot` record (catalogue row 60). */
  readonly record: JsonObject;
  /** True only when the last page carried no cursor. */
  readonly complete: boolean;
  /** How many items the read returned, all of them kept. */
  readonly transaction_count: number;
  readonly failures: readonly StructuredReason[];
}

interface LedgerPageEntry {
  readonly page_number: number;
  readonly item_count: number;
  readonly start_cursor?: string;
  readonly next_cursor?: string;
}

interface LedgerReadState {
  readonly pages: LedgerPageEntry[];
  readonly items: StoredItem[];
  readonly failures: StructuredReason[];
  complete: boolean;
}

/**
 * Reads the capture's ledger partition into a `ledger_snapshot`, written by `evidence_collector`
 * with `consistent_read: true`; `captured_at` is the instant the last read returned.
 *
 * @example
 * const ledger = await captureLedgerSnapshot(store, scope, clock);
 * ledger.complete; // false when a page read failed
 */
export async function captureLedgerSnapshot(
  reader: CollectorStoreReader,
  scope: CaptureScope,
  clock: WallClock,
): Promise<LedgerCapture> {
  const partitionKey = capturePartitionKey(scope);
  const state = await readLedgerPages(reader, partitionKey);
  const record: JsonObject = {
    schema_version: 1,
    record_type: 'ledger_snapshot',
    ...correlationFields(scope),
    writer: 'evidence_collector',
    partition_key: partitionKey,
    consistent_read: true,
    captured_at: formatUtcMillis(clock.now()),
    complete: state.complete,
    pages: state.pages.map((page) => ({ ...page })),
    transactions: state.items.map(recordOfItem),
  };
  return {
    record,
    complete: state.complete,
    transaction_count: state.items.length,
    failures: state.failures,
  };
}

async function readLedgerPages(reader: CollectorStoreReader, partitionKey: string): Promise<LedgerReadState> {
  const state: LedgerReadState = { pages: [], items: [], failures: [], complete: false };
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pageNumber = 0;
  for (;;) {
    pageNumber += 1;
    const page = await reader.queryPartitionPage('ledger', partitionKey, cursor);
    if (!page.ok) {
      state.failures.push(readFailure('LEDGER_READ_FAILED', 'ledger', partitionKey, page.error, pageNumber));
      return state;
    }
    const next = page.value.next_cursor;
    state.pages.push(pageEntry(pageNumber, page.value.items.length, cursor, next));
    pushEach(state.items, page.value.items);
    if (next === undefined) {
      state.complete = true;
      return state;
    }
    if (seen.has(next)) {
      state.failures.push(repeatedLedgerCursor(partitionKey, pageNumber));
      return state;
    }
    seen.add(next);
    cursor = next;
  }
}

function pageEntry(
  pageNumber: number,
  itemCount: number,
  start: string | undefined,
  next: string | undefined,
): LedgerPageEntry {
  return {
    page_number: pageNumber,
    item_count: itemCount,
    ...(start === undefined ? {} : { start_cursor: start }),
    ...(next === undefined ? {} : { next_cursor: next }),
  };
}

function repeatedLedgerCursor(partitionKey: string, pageNumber: number): StructuredReason {
  return {
    code: 'LEDGER_CURSOR_REPEATED',
    subject: 'BR-RUA-005',
    detail: `ledger partition ${partitionKey} returned an already-seen cursor at page ${String(pageNumber)}; expected each page to advance until no cursor remains`,
  };
}
