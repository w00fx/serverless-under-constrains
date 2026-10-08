// The typed parts of an oracle result: the verdict outcome, the scenario members, the applicable
// gate value, the indeterminate reasons and the ledger snapshot reference.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { RuleResult, ValidityGate } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import {
  applicableGateValue,
  indeterminateReasons,
  ledgerSnapshotRef,
  scenarioAssessment,
  verdictOutcome,
} from '../../../src/trial-oracle/oracle-result-assembly.ts';
import { assessTreatment } from '../../../src/trial-oracle/validity-gates.ts';
import { builtEvidence } from './support/built-trials.ts';

const reason = (code: string, subject = 'BR-RUA-001', detail = 'why'): StructuredReason => ({ code, subject, detail });

function gate(value: ValidityGate['value'], reasons: readonly StructuredReason[]): ValidityGate {
  return { gate: 'ledger_access', value, reasons, evidence_refs: [] };
}

function rule(result: RuleResult['result'], reasons: readonly StructuredReason[]): RuleResult {
  return {
    rule_id: 'BR-RUA-001',
    result,
    expected: null,
    observed: null,
    evidence_refs: [],
    indeterminate_reasons: reasons,
  };
}

describe('verdictOutcome', () => {
  it('passes with completion true on SUCCEEDED and false on another terminal reason', () => {
    assert.deepEqual(verdictOutcome('pass', 'SUCCEEDED'), {
      preservation_verdict: 'pass',
      correct_completion: true,
      processing_terminal_reason: 'SUCCEEDED',
    });
    assert.deepEqual(verdictOutcome('pass', 'RETRIES_EXHAUSTED'), {
      preservation_verdict: 'pass',
      correct_completion: false,
      processing_terminal_reason: 'RETRIES_EXHAUSTED',
    });
  });

  it('fails with completion false', () => {
    assert.deepEqual(verdictOutcome('fail', 'SUCCEEDED'), {
      preservation_verdict: 'fail',
      correct_completion: false,
      processing_terminal_reason: 'SUCCEEDED',
    });
  });

  it('is indeterminate with completion null for an indeterminate verdict, keeping the terminal reason', () => {
    assert.deepEqual(verdictOutcome('indeterminate', 'SUCCEEDED'), {
      preservation_verdict: 'indeterminate',
      correct_completion: null,
      processing_terminal_reason: 'SUCCEEDED',
    });
  });

  it('reports a pass or fail without a terminal reason as indeterminate, never an impossible combination', () => {
    for (const verdict of ['pass', 'fail'] as const) {
      assert.deepEqual(verdictOutcome(verdict, null), {
        preservation_verdict: 'indeterminate',
        correct_completion: null,
        processing_terminal_reason: null,
      });
    }
  });
});

describe('applicableGateValue', () => {
  it('keeps verified, invalid and unverified, and reads not_applicable as unverified', () => {
    assert.equal(applicableGateValue('verified'), 'verified');
    assert.equal(applicableGateValue('invalid'), 'invalid');
    assert.equal(applicableGateValue('unverified'), 'unverified');
    assert.equal(applicableGateValue('not_applicable'), 'unverified');
  });
});

describe('scenarioAssessment', () => {
  const controlGate: ValidityGate = { gate: 'control_integrity', value: 'verified', reasons: [], evidence_refs: [] };

  it('gives a CONTROL trial its control integrity and no treatment members', () => {
    assert.deepEqual(scenarioAssessment({ scenario: 'CONTROL' }, controlGate), {
      scenario: 'CONTROL',
      control_integrity: 'verified',
      treatment_fidelity: 'not_applicable',
      fidelity_basis: 'not_applicable',
      clock_assumption_refs: [],
      treatment_condition_results: [],
    });
  });

  it('gives a treatment trial its fidelity, basis, clock assumptions and six conditions', () => {
    const treatment = assessTreatment(builtEvidence({ base: 'run-conventional-treatment' }));
    assert.ok(treatment.scenario === 'COMMIT_THEN_TIMEOUT');
    const assessed = scenarioAssessment(treatment, { ...controlGate, value: 'not_applicable' });
    assert.equal(assessed.scenario, 'COMMIT_THEN_TIMEOUT');
    assert.equal(assessed.control_integrity, 'not_applicable');
    assert.equal(assessed.treatment_fidelity, 'verified');
    assert.equal(assessed.fidelity_basis, treatment.fidelity.fidelity_basis);
    assert.equal(assessed.clock_assumption_refs, treatment.fidelity.clock_assumption_refs);
    assert.equal(assessed.treatment_condition_results.length, 6);
  });
});

describe('indeterminateReasons', () => {
  it('unites the reasons of non-verified gates and indeterminate rules, without repeats, sorted', () => {
    const shared = reason('LEDGER_INCOMPLETE', 'BR-RUA-001');
    const reasons = indeterminateReasons(
      [
        gate('verified', [reason('IGNORED_VERIFIED')]),
        gate('not_applicable', [reason('IGNORED_NOT_APPLICABLE')]),
        gate('unverified', [reason('Z_LAST', 'BR-RUA-034'), shared]),
        gate('invalid', [reason('DUPLICATE_LEDGER_TRANSACTION_ID', 'BR-RUA-034')]),
      ],
      [rule('fail', [reason('IGNORED_FAIL')]), rule('indeterminate', [shared, reason('A_FIRST', 'BR-RUA-001', 'b')])],
    );
    assert.deepEqual(
      reasons.map((entry) => `${entry.subject} ${entry.code}`),
      [
        'BR-RUA-001 A_FIRST',
        'BR-RUA-001 LEDGER_INCOMPLETE',
        'BR-RUA-034 DUPLICATE_LEDGER_TRANSACTION_ID',
        'BR-RUA-034 Z_LAST',
      ],
    );
  });

  it('orders reasons of one subject and code by artifact path, event id and detail', () => {
    const at = (artifact: string | undefined, event: string | undefined, detail: string): StructuredReason => ({
      code: 'C',
      subject: 'S',
      detail,
      ...(artifact === undefined ? {} : { artifact_path: artifact }),
      ...(event === undefined ? {} : { event_id: event as Uuid4 }),
    });
    const reasons = indeterminateReasons(
      [
        gate('unverified', [
          at('b', undefined, 'x'),
          at('a', 'e2', 'x'),
          at('a', 'e1', 'y'),
          at(undefined, undefined, 'z'),
        ]),
      ],
      [],
    );
    assert.deepEqual(
      reasons.map((entry) => [entry.artifact_path ?? '', entry.event_id ?? '', entry.detail]),
      [
        ['', '', 'z'],
        ['a', 'e1', 'y'],
        ['a', 'e2', 'x'],
        ['b', '', 'x'],
      ],
    );
  });
});

describe('ledgerSnapshotRef', () => {
  it('cites the stored snapshot by its path and digest', () => {
    const evidence = builtEvidence({ base: 'run-conventional-control' });
    const snapshot = evidence.ledger.snapshot;
    assert.ok(snapshot !== undefined);
    assert.deepEqual(ledgerSnapshotRef(evidence), {
      artifact_path: snapshot.artifact_path,
      artifact_sha256: snapshot.artifact_sha256,
    });
  });

  it('cites the expected path with the digest of zero bytes when no snapshot was stored', () => {
    const evidence = builtEvidence({
      base: 'run-conventional-control',
      operations: [{ op: 'delete_file', path: '$trial/ledger/ledger-snapshot.json' }],
    });
    const ref = ledgerSnapshotRef(evidence);
    assert.match(ref.artifact_path, /^trials\/[0-9a-f-]+\/ledger\/ledger-snapshot\.json$/);
    assert.equal(ref.artifact_sha256, sha256Hex(new Uint8Array()));
  });
});
