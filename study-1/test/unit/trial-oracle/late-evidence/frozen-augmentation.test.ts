// The frozen evidence plus the late records (AC-RUA-030 "never modifies frozen results or
// digests"): late lines are appended and late documents folded into new bytes, a new file is added
// after the frozen ones, the frozen input is left as it was, and an extended file's index entry is
// set aside only when the frozen bytes matched it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionInput } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonObject, Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { LateEvidenceRecord } from '../../../../src/record-contract/records/group-c/late_evidence_record.ts';
import { augmentFrozenEvidence } from '../../../../src/trial-oracle/late-evidence/frozen-augmentation.ts';
import type { LateRoute } from '../../../../src/trial-oracle/late-evidence/late-record-routing.ts';
import type { AcceptedLateRecord } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import { ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from '../support/trial-plans.ts';
import { duplicateSignal, frozenFixture, lateLedger, lateRecord } from './support/late-fixtures.ts';

const encoder = new TextEncoder();
const control = frozenFixture(CONVENTIONAL_CONTROL);
const treatment = frozenFixture(CONVENTIONAL_TREATMENT);
const LEDGER = `trials/${control.result.trial_id}/ledger/ledger-snapshot.json`;
const CONTROLLER = `trials/${treatment.result.trial_id}/journals/controller-journal.jsonl`;
const NEW_FILE = `trials/${control.result.trial_id}/queues/dlq-snapshot.json`;

function accepted(record: JsonObject, route: LateRoute, line = 1): AcceptedLateRecord {
  return { record: record as unknown as LateEvidenceRecord, route, line_number: line };
}

const ledgerLate = (extra: 0 | 1, path = LEDGER): AcceptedLateRecord =>
  accepted(lateRecord(control, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(control, extra) }), {
    path,
    fold: 'ledger_transactions',
    shared: false,
  });

const signalLate = (): AcceptedLateRecord =>
  accepted(
    lateRecord(treatment, { sequence: 1, late_source: 'CONTROLLER_JOURNAL', late_record: duplicateSignal(treatment) }),
    { path: CONTROLLER, fold: 'append_line', shared: false },
  );

function bytesAt(input: IngestionInput, path: string): Uint8Array | undefined {
  return input.artifacts.find((artifact) => artifact.path === path)?.bytes;
}

describe('augmentFrozenEvidence', () => {
  it('appends a late event as one more canonical line of its frozen journal', () => {
    const frozenBytes = bytesAt(treatment.frozen, CONTROLLER) ?? new Uint8Array();
    const augmented = augmentFrozenEvidence(treatment.frozen, [signalLate()], ORACLE_VALIDATOR);
    assert.deepEqual(augmented.problems, []);
    const line = encoder.encode(`${canonicalJson(duplicateSignal(treatment))}\n`);
    assert.deepEqual(bytesAt(augmented.input, CONTROLLER), Uint8Array.from([...frozenBytes, ...line]));
    assert.equal(augmented.input.artifacts.length, treatment.frozen.artifacts.length);
    assert.equal(augmented.input.expected, treatment.frozen.expected);
    assert.equal(augmented.input.execution_scope_artifacts, treatment.frozen.execution_scope_artifacts);
  });

  it('folds a late document and leaves every other file the frozen bytes', () => {
    const augmented = augmentFrozenEvidence(control.frozen, [ledgerLate(1)], ORACLE_VALIDATOR);
    const ledger = JSON.parse(new TextDecoder().decode(bytesAt(augmented.input, LEDGER))) as JsonObject;
    assert.equal((ledger['transactions'] as unknown[]).length, 2);
    for (const artifact of augmented.input.artifacts.filter((candidate) => candidate.path !== LEDGER)) {
      assert.equal(artifact.bytes, bytesAt(control.frozen, artifact.path));
    }
  });

  it('never changes the frozen input', () => {
    const before = structuredClone(control.frozen);
    augmentFrozenEvidence(control.frozen, [ledgerLate(1), ledgerLate(1, NEW_FILE)], ORACLE_VALIDATOR);
    assert.deepEqual(control.frozen, before);
  });

  it('adds a file the frozen evidence lacks after the frozen files', () => {
    const augmented = augmentFrozenEvidence(control.frozen, [ledgerLate(1, NEW_FILE)], ORACLE_VALIDATOR);
    assert.equal(augmented.input.artifacts.at(-1)?.path, NEW_FILE);
    assert.equal(augmented.input.artifacts.length, control.frozen.artifacts.length + 1);
  });

  it('starts a journal the frozen evidence lacks with the late line', () => {
    const partition = 'provider/provider-journal.jsonl';
    assert.equal(bytesAt(treatment.frozen, partition), undefined);
    const record = signalLate();
    const augmented = augmentFrozenEvidence(
      treatment.frozen,
      [{ ...record, route: { path: partition, fold: 'append_line', shared: true } }],
      ORACLE_VALIDATOR,
    );
    assert.deepEqual(
      bytesAt(augmented.input, partition),
      encoder.encode(`${canonicalJson(duplicateSignal(treatment))}\n`),
    );
  });

  it('joins several records of one file in stream order', () => {
    const augmented = augmentFrozenEvidence(treatment.frozen, [signalLate(), signalLate()], ORACLE_VALIDATOR);
    const text = new TextDecoder().decode(bytesAt(augmented.input, CONTROLLER));
    assert.equal(text.split('\n').filter((line) => line.includes('timeout_signal_duplicate_observed')).length, 2);
  });

  it('reports a record that cannot join its frozen file and leaves that file as frozen', () => {
    const truncated: IngestionInput = {
      ...treatment.frozen,
      artifacts: treatment.frozen.artifacts.map((artifact) =>
        artifact.path === CONTROLLER ? { path: CONTROLLER, bytes: encoder.encode('{"open":true}') } : artifact,
      ),
    };
    const unappendable = augmentFrozenEvidence(truncated, [signalLate()], ORACLE_VALIDATOR);
    assert.deepEqual(
      unappendable.problems.map((problem) => [problem.code, problem.artifact_path]),
      [['LATE_DOCUMENT_UNFOLDABLE', CONTROLLER]],
    );
    assert.match(unappendable.problems[0]?.detail ?? '', /^late stream line 1: the frozen file ends without a newline/);
    assert.deepEqual(bytesAt(unappendable.input, CONTROLLER), encoder.encode('{"open":true}'));

    const invalid = ledgerLate(1);
    const broken = accepted(
      { ...(invalid.record as unknown as JsonObject), late_record: { record_type: 'ledger_snapshot' } },
      invalid.route,
      4,
    );
    const unfoldable = augmentFrozenEvidence(control.frozen, [broken], ORACLE_VALIDATOR);
    assert.match(
      unfoldable.problems[0]?.detail ?? '',
      /^late stream line 4: the late document is not a valid ledger_snapshot/,
    );
    assert.equal(bytesAt(unfoldable.input, LEDGER), bytesAt(control.frozen, LEDGER));
  });

  it('appends to an empty frozen journal', () => {
    const empty: IngestionInput = {
      ...treatment.frozen,
      artifacts: treatment.frozen.artifacts.map((artifact) =>
        artifact.path === CONTROLLER ? { path: CONTROLLER, bytes: new Uint8Array() } : artifact,
      ),
    };
    const augmented = augmentFrozenEvidence(empty, [signalLate()], ORACLE_VALIDATOR);
    assert.deepEqual(
      bytesAt(augmented.input, CONTROLLER),
      encoder.encode(`${canonicalJson(duplicateSignal(treatment))}\n`),
    );
  });

  it('gives no index to evidence that had none', () => {
    const augmented = augmentFrozenEvidence(control.frozen, [ledgerLate(1)], ORACLE_VALIDATOR);
    assert.equal(Object.hasOwn(augmented.input, 'indexed_digests'), false);
  });

  it('sets aside the index entry of an extended file whose frozen bytes matched it, and keeps every other entry', () => {
    const frozenLedger = bytesAt(control.frozen, LEDGER) ?? new Uint8Array();
    const payment = `trials/${control.result.trial_id}/inputs/payment.json`;
    const mismatched = 'a'.repeat(64) as Sha256Hex;
    const indexed = new Map<string, Sha256Hex>([
      [LEDGER, sha256Hex(frozenLedger)],
      [payment, sha256Hex(bytesAt(control.frozen, payment) ?? new Uint8Array())],
      [NEW_FILE, mismatched],
    ]);
    const augmented = augmentFrozenEvidence(
      { ...control.frozen, indexed_digests: indexed },
      [ledgerLate(1), ledgerLate(1, NEW_FILE)],
      ORACLE_VALIDATOR,
    );
    assert.deepEqual(
      [...(augmented.input.indexed_digests ?? new Map<string, Sha256Hex>())].map(([path]) => path),
      [payment, NEW_FILE],
    );

    const disagreeing = new Map<string, Sha256Hex>([[LEDGER, mismatched]]);
    const kept = augmentFrozenEvidence(
      { ...control.frozen, indexed_digests: disagreeing },
      [ledgerLate(1)],
      ORACLE_VALIDATOR,
    );
    assert.deepEqual([...(kept.input.indexed_digests ?? new Map<string, Sha256Hex>())], [[LEDGER, mismatched]]);
    assert.equal(indexed.size, 3);
  });
});
