// Design §8.2 step I7 (BR-RUA-034, BR-RUA-037; AC-RUA-007 case 1): duplicate transaction ids,
// pagination that must prove the whole partition was read, and a larger-than-expected ledger that
// is reported but never truncated.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginationProblems, readLedger } from '../../../src/evidence-ingestion/ledger-view.ts';
import type { LedgerReading } from '../../../src/evidence-ingestion/ledger-view.ts';
import type { IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { LedgerPage, LedgerSnapshot } from '../../../src/record-contract/records/group-b/ledger_snapshot.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import { ingest, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';

const LEDGER = '$trial/ledger/ledger-snapshot.json';
const DUPLICATE = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';

function ledgerOf(input: IngestionInput): LedgerReading {
  const evidence = ingest(input);
  return { view: evidence.ledger, findings: evidence.findings.filter((finding) => finding.code.includes('LEDGER')) };
}

function snapshot(pages: readonly LedgerPage[], transactions = 1, complete = true): LedgerSnapshot {
  return {
    complete,
    pages,
    transactions: Array.from({ length: transactions }, () => ({})),
  } as unknown as LedgerSnapshot;
}

describe('readLedger', () => {
  it('reads a complete single-transaction snapshot', () => {
    const { view, findings } = ledgerOf(trialInput());
    assert.equal(view.status, 'present');
    assert.equal(view.transactions.length, 1);
    assert.equal(view.pagination_complete, true);
    assert.deepEqual(view.pagination_problems, []);
    assert.deepEqual(view.duplicate_transaction_ids, []);
    assert.equal(view.snapshot?.correlation_missing, false);
    assert.deepEqual(findings, []);
  });

  it('is missing without a snapshot and unusable when it does not parse or validate', () => {
    const input = trialInput();
    const path = `${subjectOf(input)}/ledger/ledger-snapshot.json`;
    const missing = readLedger([]);
    assert.equal(missing.view.status, 'missing');
    assert.deepEqual(missing.view.pagination_problems, ['ledger snapshot is missing']);
    assert.equal(ledgerOf(withArtifact(input, path, undefined)).view.status, 'missing');
    for (const bytes of [text('{'), text('{"record_type":"ledger_snapshot"}')]) {
      const { view, findings } = ledgerOf(withArtifact(input, path, bytes));
      assert.equal(view.status, 'unusable');
      assert.equal(view.pagination_complete, false);
      assert.deepEqual(view.transactions, []);
      assert.deepEqual(findings, []);
    }
  });

  it('keeps every transaction of a larger ledger and reports it as informational', () => {
    const { view, findings } = ledgerOf(trialInput('run-conventional-treatment'));
    assert.equal(view.transactions.length, 2);
    assert.equal(view.pagination_complete, true);
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.detail]),
      [['LEDGER_LARGER_THAN_EXPECTED', 'expected at most 1 transaction; the snapshot holds 2, every one kept']],
    );
  });

  it('reports a duplicate provider_transaction_id', () => {
    const operations: readonly ScenarioOperation[] = [0, 1].map((index) => ({
      op: 'set',
      path: LEDGER,
      pointer: `/transactions/${String(index)}/provider_transaction_id`,
      value: DUPLICATE,
    }));
    const { view, findings } = ledgerOf(trialInput('run-conventional-treatment', operations));
    assert.deepEqual(view.duplicate_transaction_ids, [DUPLICATE]);
    const duplicate = findings.find((finding) => finding.code === 'DUPLICATE_LEDGER_TRANSACTION_ID');
    assert.equal(
      duplicate?.detail,
      `expected one transaction per provider_transaction_id; ${DUPLICATE} appears more than once`,
    );
    assert.equal(duplicate.occurrences, 1);
  });

  it('reports incomplete pagination with every problem counted', () => {
    const operations: readonly ScenarioOperation[] = [
      { op: 'set', path: LEDGER, pointer: '/complete', value: false },
      { op: 'set', path: LEDGER, pointer: '/pages/0/next_cursor', value: 'page-2' },
    ];
    const { view, findings } = ledgerOf(trialInput('run-conventional-control', operations));
    assert.equal(view.pagination_complete, false);
    assert.deepEqual(view.pagination_problems, ['complete is false', 'the last page has next_cursor page-2']);
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.occurrences, finding.detail]),
      [['LEDGER_PAGINATION_INCOMPLETE', 2, 'expected complete pagination; complete is false (and 1 more)']],
    );
  });
});

describe('paginationProblems', () => {
  it('accepts pages chained by their cursors whose counts sum to the transactions', () => {
    const pages = [
      { page_number: 1, item_count: 2, next_cursor: 'c2' },
      { page_number: 2, item_count: 1, start_cursor: 'c2' },
    ];
    assert.deepEqual(paginationProblems(snapshot(pages, 3)), []);
  });

  it('names each way pagination fails to prove completeness', () => {
    assert.deepEqual(paginationProblems(snapshot([], 0)), ['no page is recorded']);
    assert.deepEqual(paginationProblems(snapshot([{ page_number: 2, item_count: 1 }])), [
      'page 1 is numbered 2; expected 1',
    ]);
    assert.deepEqual(
      paginationProblems(
        snapshot([
          { page_number: 1, item_count: 0 },
          { page_number: 2, item_count: 1 },
        ]),
      ),
      ['page 1 has no next_cursor although page 2 follows'],
    );
    assert.deepEqual(
      paginationProblems(
        snapshot([
          { page_number: 1, item_count: 0, next_cursor: 'a' },
          { page_number: 2, item_count: 1, start_cursor: 'b' },
        ]),
      ),
      ["page 2 does not start at page 1's next_cursor a"],
    );
    assert.deepEqual(paginationProblems(snapshot([{ page_number: 1, item_count: 3 }], 2)), [
      'page item counts sum to 3; the snapshot holds 2',
    ]);
  });

  it('reports a misnumbered page together with its cursor problem', () => {
    assert.deepEqual(
      paginationProblems(
        snapshot([
          { page_number: 3, item_count: 0, next_cursor: 'a' },
          { page_number: 4, item_count: 1, start_cursor: 'b', next_cursor: 'z' },
        ]),
      ),
      [
        'page 1 is numbered 3; expected 1',
        "page 2 does not start at page 1's next_cursor a",
        'page 2 is numbered 4; expected 2',
        'the last page has next_cursor z',
      ],
    );
    assert.deepEqual(
      paginationProblems(
        snapshot([
          { page_number: 5, item_count: 0 },
          { page_number: 2, item_count: 1 },
        ]),
      ),
      ['page 1 is numbered 5; expected 1', 'page 1 has no next_cursor although page 2 follows'],
    );
  });
});
