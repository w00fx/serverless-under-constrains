// Design §8.2 step I7 (BR-RUA-034, BR-RUA-037): the subject's ledger snapshot. A repeated
// `provider_transaction_id` is DUPLICATE_LEDGER_TRANSACTION_ID (ledger access invalid). The ledger
// is complete only when the snapshot declares `complete: true`, its pages are numbered 1..n, each
// non-last page's `next_cursor` starts the next page, the last page has no cursor, and the page
// counts sum to the transactions held; anything else is LEDGER_PAGINATION_INCOMPLETE (ledger
// access unverified, AC-RUA-007 case 1). More than the one expected transaction is
// LEDGER_LARGER_THAN_EXPECTED, which is informational: every transaction is kept and evaluated,
// never truncated.

import type { LedgerPage, LedgerSnapshot } from '../record-contract/records/group-b/ledger_snapshot.ts';
import { aggregatedDetail, ingestionFinding } from './ingestion-findings.ts';
import type { IngestedArtifact, IngestionFinding, LedgerView, LocatedRecord } from './ingestion-model.ts';
import { soleRecord, subjectArtifact } from './located-records.ts';

/** BR-RUA-034 "expected size": one refund request commits at most one transaction. */
const EXPECTED_TRANSACTION_COUNT = 1;

export interface LedgerReading {
  readonly view: LedgerView;
  readonly findings: readonly IngestionFinding[];
}

/**
 * Reads the subject's ledger snapshot and classifies its duplicates, pagination and size.
 *
 * @example
 * const { view } = readLedger(artifacts);
 * view.status; // 'present' | 'missing' | 'unusable'
 */
export function readLedger(artifacts: readonly IngestedArtifact[]): LedgerReading {
  const snapshot = soleRecord<LedgerSnapshot>(artifacts, 'ledger_snapshot');
  if (snapshot === undefined) {
    const status = subjectArtifact(artifacts, 'ledger_snapshot') === undefined ? 'missing' : 'unusable';
    return {
      view: {
        status,
        transactions: [],
        duplicate_transaction_ids: [],
        pagination_complete: false,
        pagination_problems: [`ledger snapshot is ${status}`],
      },
      findings: [],
    };
  }
  const transactions = snapshot.record.transactions;
  const duplicates = duplicateTransactionIds(snapshot.record);
  const problems = paginationProblems(snapshot.record);
  return {
    view: {
      status: 'present',
      snapshot,
      transactions,
      duplicate_transaction_ids: duplicates,
      pagination_complete: problems.length === 0,
      pagination_problems: problems,
    },
    findings: [
      ...duplicateFindings(snapshot, duplicates),
      ...paginationFindings(snapshot, problems),
      ...sizeFindings(snapshot),
    ],
  };
}

function duplicateTransactionIds(snapshot: LedgerSnapshot): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const transaction of snapshot.transactions) {
    const id = transaction.provider_transaction_id;
    (seen.has(id) ? repeated : seen).add(id);
  }
  return [...repeated].toSorted();
}

/**
 * Every reason a snapshot's pagination does not prove it holds the whole partition; empty when
 * it does.
 *
 * @example
 * paginationProblems({ ...snapshot, complete: false }); // ['complete is false']
 */
export function paginationProblems(snapshot: LedgerSnapshot): readonly string[] {
  const pages = snapshot.pages;
  const declared = pages.reduce((total, page) => total + page.item_count, 0);
  return [
    ...(snapshot.complete ? [] : ['complete is false']),
    ...(pages.length === 0 ? ['no page is recorded'] : []),
    ...pages.flatMap((page, index) => pageProblems(page, index, pages)),
    ...(declared === snapshot.transactions.length
      ? []
      : [`page item counts sum to ${String(declared)}; the snapshot holds ${String(snapshot.transactions.length)}`]),
  ];
}

function pageProblems(page: LedgerPage, index: number, pages: readonly LedgerPage[]): readonly string[] {
  const label = `page ${String(index + 1)}`;
  const numbering =
    page.page_number === index + 1
      ? []
      : [`${label} is numbered ${String(page.page_number)}; expected ${String(index + 1)}`];
  const next = pages[index + 1];
  if (next === undefined) {
    return page.next_cursor === undefined
      ? numbering
      : [...numbering, `the last page has next_cursor ${page.next_cursor}`];
  }
  if (page.next_cursor === undefined) {
    return [...numbering, `${label} has no next_cursor although page ${String(index + 2)} follows`];
  }
  return next.start_cursor === page.next_cursor
    ? numbering
    : [...numbering, `page ${String(index + 2)} does not start at ${label}'s next_cursor ${page.next_cursor}`];
}

function duplicateFindings(
  snapshot: LocatedRecord<LedgerSnapshot>,
  duplicates: readonly string[],
): readonly IngestionFinding[] {
  const [first] = duplicates;
  if (first === undefined) {
    return [];
  }
  const detail = aggregatedDetail(
    `expected one transaction per provider_transaction_id; ${first} appears more than once`,
    duplicates.length,
  );
  return [
    ingestionFinding('DUPLICATE_LEDGER_TRANSACTION_ID', detail, {
      artifact_path: snapshot.artifact_path,
      occurrences: duplicates.length,
    }),
  ];
}

function paginationFindings(
  snapshot: LocatedRecord<LedgerSnapshot>,
  problems: readonly string[],
): readonly IngestionFinding[] {
  const [first] = problems;
  if (first === undefined) {
    return [];
  }
  const detail = aggregatedDetail(`expected complete pagination; ${first}`, problems.length);
  return [
    ingestionFinding('LEDGER_PAGINATION_INCOMPLETE', detail, {
      artifact_path: snapshot.artifact_path,
      occurrences: problems.length,
    }),
  ];
}

function sizeFindings(snapshot: LocatedRecord<LedgerSnapshot>): readonly IngestionFinding[] {
  const count = snapshot.record.transactions.length;
  if (count <= EXPECTED_TRANSACTION_COUNT) {
    return [];
  }
  const detail = `expected at most ${String(EXPECTED_TRANSACTION_COUNT)} transaction; the snapshot holds ${String(count)}, every one kept`;
  return [ingestionFinding('LEDGER_LARGER_THAN_EXPECTED', detail, { artifact_path: snapshot.artifact_path })];
}
