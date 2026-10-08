// Folding a re-captured document into its frozen copy (design §8.13): the frozen document keeps
// every member and gains the late items it lacks, each once; the ledger's last page counts them;
// nothing new returns the frozen bytes themselves; an invalid side is a reason, never a throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { foldLateDocument } from '../../../../src/trial-oracle/late-evidence/document-folding.ts';
import { builtFiles, ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { subjectRecord } from '../support/trial-edits.ts';
import { CONVENTIONAL_CONTROL, DLQ_TREATMENT, DURABLE_CONTROL } from '../support/trial-plans.ts';
import { frozenFixture, lateLedger, firstOf, refusalOf } from './support/late-fixtures.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const control = frozenFixture(CONVENTIONAL_CONTROL);
const LEDGER_PATH = `trials/${control.result.trial_id}/ledger/ledger-snapshot.json`;
const frozenLedger = (): Uint8Array => builtFiles(CONVENTIONAL_CONTROL).get(LEDGER_PATH) ?? new Uint8Array();
const bytesOf = (document: JsonObject): Uint8Array => encoder.encode(`${canonicalJson(document)}\n`);
const parsed = (bytes: Uint8Array): JsonObject => JSON.parse(decoder.decode(bytes)) as JsonObject;

describe('foldLateDocument', () => {
  it('appends the late transactions the frozen ledger lacks and counts them on the last page', () => {
    const folded = foldLateDocument('ledger_transactions', frozenLedger(), lateLedger(control, 1), ORACLE_VALIDATOR);
    assert.ok(folded.ok);
    const ledger = parsed(folded.value);
    const frozen = parsed(frozenLedger());
    assert.deepEqual(ledger['transactions'], lateLedger(control, 1)['transactions']);
    assert.deepEqual(ledger['pages'], [{ ...(frozen['pages'] as JsonObject[])[0], item_count: 2 }]);
    assert.equal(ledger['captured_at'], frozen['captured_at']);
    assert.equal(decoder.decode(folded.value).endsWith('}\n'), true);
  });

  it('returns the frozen bytes themselves when the late document adds nothing', () => {
    const frozen = frozenLedger();
    const folded = foldLateDocument('ledger_transactions', frozen, lateLedger(control, 0), ORACLE_VALIDATOR);
    assert.ok(folded.ok);
    assert.equal(folded.value, frozen);
  });

  it('adds each late item once', () => {
    const late = lateLedger(control, 1);
    const repeated = {
      ...late,
      transactions: [...(late['transactions'] as JsonObject[]), ...(late['transactions'] as JsonObject[])],
    };
    const folded = foldLateDocument('ledger_transactions', frozenLedger(), repeated, ORACLE_VALIDATOR);
    assert.ok(folded.ok);
    assert.equal((parsed(folded.value)['transactions'] as JsonObject[]).length, 2);
  });

  it('keeps the pages of a ledger without pages', () => {
    const pageless = { ...parsed(frozenLedger()), pages: [] };
    const folded = foldLateDocument('ledger_transactions', bytesOf(pageless), lateLedger(control, 1), ORACLE_VALIDATOR);
    assert.ok(folded.ok);
    assert.deepEqual(parsed(folded.value)['pages'], []);
  });

  it('places the late document alone when nothing was frozen', () => {
    const late = lateLedger(control, 1);
    const folded = foldLateDocument('ledger_transactions', undefined, late, ORACLE_VALIDATOR);
    assert.ok(folded.ok);
    assert.deepEqual(folded.value, bytesOf(late));
  });

  it('folds DLQ messages and Durable executions by their item lists', () => {
    const dlq = subjectRecord(DLQ_TREATMENT, '$trial/queues/dlq-snapshot.json', 'dlq_snapshot');
    const first = firstOf(dlq['messages'] as JsonObject[]);
    const lateDlq = { ...dlq, messages: [first, { ...first, message_id: 'late-message-2' }] };
    const dlqFolded = foldLateDocument('dlq_messages', bytesOf(dlq), lateDlq, ORACLE_VALIDATOR);
    assert.ok(dlqFolded.ok);
    assert.deepEqual(parsed(dlqFolded.value)['messages'], lateDlq.messages);

    const durable = subjectRecord(
      DURABLE_CONTROL,
      '$trial/execution-metadata/durable-executions.json',
      'durable_execution_metadata',
    );
    const [execution] = durable['executions'] as JsonObject[];
    const late = { ...durable, executions: [{ ...execution, durable_execution_name: 'late-execution' }] };
    const durableFolded = foldLateDocument('durable_executions', bytesOf(durable), late, ORACLE_VALIDATOR);
    assert.ok(durableFolded.ok);
    assert.deepEqual(parsed(durableFolded.value)['executions'], [execution, late.executions[0]]);
  });

  it('refuses a late document that is not a valid record of the fold', () => {
    const { pages, ...pageless } = lateLedger(control, 1);
    assert.ok(pages !== undefined);
    const folded = foldLateDocument('ledger_transactions', frozenLedger(), pageless, ORACLE_VALIDATOR);
    assert.equal(folded.ok, false);
    assert.match(refusalOf(folded), /^the late document is not a valid ledger_snapshot: ".*pages/);
  });

  it('refuses a frozen copy that is unreadable or invalid', () => {
    const late = lateLedger(control, 1);
    const unreadable = foldLateDocument('ledger_transactions', encoder.encode('{"pages":'), late, ORACLE_VALIDATOR);
    assert.deepEqual(unreadable, {
      ok: false,
      error: 'the frozen document is unreadable (invalid_json); expected one JSON ledger_snapshot',
    });
    const invalid = foldLateDocument(
      'ledger_transactions',
      bytesOf({ record_type: 'ledger_snapshot' }),
      late,
      ORACLE_VALIDATOR,
    );
    assert.match(refusalOf(invalid), /^the frozen document is not a valid ledger_snapshot: /);
  });
});
