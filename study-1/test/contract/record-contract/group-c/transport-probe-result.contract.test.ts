// AC-RUA-046 (group C, row 69): the cross-field rules of the transport-probe result. The record
// qualifies a transport, so it enforces the spec rules on its own members: the BR-RUA-027
// cardinality and verdict precedence, the AC-RUA-021 expected cardinality of a pass, and the
// design §8.10 treatment-fidelity derivation under CA-1 (AC-RUA-002, D-05). Each case breaks one
// rule of a valid example and expects the rejection at the member that rule governs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { assertAccepted, assertForbidden, assertRejected } from '../group-b/support/group-b-validation.ts';
import { withValueAt } from '../group-b/support/json-paths.ts';
import { RUN_ID, TRIAL_ID, toJson } from '../group-b/support/record-builders.ts';
import {
  failingTransportProbeResult,
  invalidTransportProbeResult,
  passingTransportProbeResult,
} from './examples/probe-examples.ts';
import { edited, recordWithValueAt } from './support/json-edits.ts';
import { groupCSchemaPath } from './support/schema-reading.ts';

describe('AC-RUA-046 transport_probe_result rules', () => {
  const passing = toJson(passingTransportProbeResult());
  const invalid = toJson(invalidTransportProbeResult());
  const failing = toJson(failingTransportProbeResult());
  const cardinality = (callers: number, calls: number, transactions: number): JsonObject => ({
    caller_invocations: callers,
    accepted_provider_calls: calls,
    committed_transactions: transactions,
  });
  /** An unaffected (empty affected_by) failing condition at `position` of a passing probe. */
  const withUnaffectedFail = (record: JsonObject, position: number): JsonObject =>
    recordWithValueAt(
      recordWithValueAt(record, ['condition_results', position, 'result'], 'fail'),
      ['condition_results', position, 'observed'],
      { holds: false },
    );

  it('a count above 1 makes the probe invalid, and only such a count does (BR-RUA-027, design §8.11)', () => {
    // BR-RUA-027: "An additional accepted provider call or transaction makes probe_validity = invalid".
    const counts: readonly (readonly [string, JsonObject])[] = [
      ['two caller invocations', cardinality(2, 1, 1)],
      ['two accepted provider calls', cardinality(1, 2, 1)],
      ['two committed transactions', cardinality(1, 1, 2)],
    ];
    for (const [label, counted] of counts) {
      assertRejected(
        edited(passing, { probe_cardinality: counted }),
        `valid probe with ${label}`,
        '/probe_validity const',
      );
      assertRejected(
        edited(failing, { probe_cardinality: counted }),
        `failing valid probe with ${label}`,
        '/probe_validity const',
      );
      assertAccepted(edited(invalid, { probe_cardinality: counted }), `invalid probe with ${label}`);
    }
    assertRejected(
      edited(invalid, { probe_cardinality: cardinality(1, 1, 1) }),
      'invalid probe with the expected cardinality',
      '/probe_cardinality anyOf',
    );
    assertRejected(
      edited(invalid, { probe_cardinality: cardinality(1, 0, 0) }),
      'invalid probe with no count above 1',
      '/probe_cardinality anyOf',
    );
    assertAccepted(
      edited(failing, { probe_cardinality: cardinality(0, 0, 0) }),
      'counts of 0 are left to the conditions',
    );
  });

  it('a pass carries the expected cardinality 1/1/1 (AC-RUA-021)', () => {
    const shortfalls: readonly (readonly [string, JsonObject, string])[] = [
      ['no caller invocation', cardinality(0, 1, 1), 'caller_invocations'],
      ['no accepted provider call', cardinality(1, 0, 1), 'accepted_provider_calls'],
      ['no committed transaction', cardinality(1, 1, 0), 'committed_transactions'],
    ];
    for (const [label, counted, member] of shortfalls) {
      assertRejected(
        edited(passing, { probe_cardinality: counted }),
        `pass with ${label}`,
        `/probe_cardinality/${member} const`,
      );
    }
    assertRejected(
      edited(passing, { probe_cardinality: cardinality(1, 0, 0) }),
      'pass with one invocation only',
      '/probe_cardinality/accepted_provider_calls const',
    );
  });

  it('the verdict follows the BR-RUA-027 precedence over the record members', () => {
    // A pass needs a probe that is not invalid, verified evidence and six passing conditions.
    assertAccepted(edited(passing, { probe_validity: 'indeterminate' }), 'pass of an indeterminate-validity probe');
    assertRejected(
      edited(passing, { probe_validity: 'invalid' }),
      'pass of an invalid probe',
      '/transport_probe_verdict const',
    );
    assertRejected(
      edited(passing, { evidence_integrity: 'unverified' }),
      'pass of unverified evidence',
      '/evidence_integrity const',
    );
    assertRejected(
      withValueAt(passing, ['condition_results', 2, 'result'], 'indeterminate'),
      'pass with an indeterminate condition',
      '/condition_results/2/result const',
    );
    // Not invalid, no unaffected fail, six passes and verified evidence: the precedence gives pass.
    for (const verdict of ['fail', 'indeterminate']) {
      assertRejected(
        edited(passing, { transport_probe_verdict: verdict }),
        `${verdict} where the precedence gives pass`,
        '/transport_probe_verdict const',
      );
      assertRejected(
        edited(passing, { transport_probe_verdict: verdict, probe_validity: 'indeterminate' }),
        `${verdict} of an indeterminate-validity probe where the precedence gives pass`,
        '/transport_probe_verdict const',
      );
    }
    // Not invalid with an unaffected failing condition: the precedence gives fail.
    assertAccepted(failing, 'fail of a valid probe');
    assertAccepted(edited(failing, { probe_validity: 'indeterminate' }), 'fail of an indeterminate-validity probe');
    assertAccepted(edited(failing, { evidence_integrity: 'unverified' }), 'fail with unverified evidence');
    assertRejected(
      edited(failing, { transport_probe_verdict: 'indeterminate' }),
      'indeterminate where an unaffected condition fails',
      '/transport_probe_verdict const',
    );
    // Neither: indeterminate.
    const unverified = edited(passing, {
      transport_probe_verdict: 'indeterminate',
      evidence_integrity: 'unverified',
      treatment_fidelity: 'verified',
    });
    assertAccepted(unverified, 'indeterminate with unverified evidence and six passes');
  });

  it('a fail has an unaffected failing condition (BR-RUA-027)', () => {
    // A failing condition affected by an integrity finding is not conclusive (design §8.10).
    const affected = recordWithValueAt(failing, ['condition_results', 0, 'affected_by'], ['SOURCE_SEQUENCE_GAP']);
    assertRejected(affected, 'fail whose only failing condition is affected', '/condition_results contains');
    assertAccepted(
      edited(affected, { transport_probe_verdict: 'indeterminate', treatment_fidelity: 'unverified' }),
      'an affected failing condition leaves the probe indeterminate',
    );
    const sixPasses = edited(passing, { transport_probe_verdict: 'fail', evidence_integrity: 'unverified' });
    assertRejected(sixPasses, 'fail with six passing conditions', '/condition_results contains');
  });

  it('treatment fidelity follows the six conditions under CA-1 (design §8.10, AC-RUA-002, D-05)', () => {
    assertRejected(
      recordWithValueAt(
        edited(passing, { transport_probe_verdict: 'indeterminate' }),
        ['condition_results', 4, 'result'],
        'indeterminate',
      ),
      'verified fidelity with an indeterminate condition',
      '/condition_results/4/result const',
    );
    assertRejected(
      edited(failing, { treatment_fidelity: 'verified' }),
      'verified fidelity with an unaffected failing condition',
      '/treatment_fidelity const',
    );
    assertRejected(
      edited(failing, { treatment_fidelity: 'unverified' }),
      'unverified fidelity with an unaffected failing condition',
      '/treatment_fidelity const',
    );
    assertRejected(
      edited(passing, { fidelity_basis: 'causal', clock_assumption_refs: [] }),
      'verified fidelity on a causal basis without CA-1',
      '/fidelity_basis const',
    );
    assertAccepted(
      edited(withUnaffectedFail(passing, 3), {
        transport_probe_verdict: 'fail',
        treatment_fidelity: 'invalid',
        fidelity_basis: 'causal',
        clock_assumption_refs: [],
      }),
      'the spec vocabulary keeps causal for a fidelity that is not verified',
    );
  });

  it('a pass or fail condition cites evidence (BR-RUA-035)', () => {
    assertRejected(
      withValueAt(passing, ['condition_results', 0, 'evidence_refs'], []),
      'pass condition without reference',
      '/condition_results/0/evidence_refs minItems',
    );
    assertRejected(
      withValueAt(invalid, ['condition_results', 0, 'evidence_refs'], []),
      'fail condition without reference',
      '/condition_results/0/evidence_refs minItems',
    );
    assertAccepted(
      withValueAt(invalid, ['condition_results', 1, 'evidence_refs'], []),
      'indeterminate condition without reference',
    );
  });

  it('an invalid probe is indeterminate', () => {
    assertRejected(
      edited(invalid, { transport_probe_verdict: 'fail' }),
      'fail of invalid probe',
      '/transport_probe_verdict const',
    );
    assertRejected(edited(invalid, { transport_probe_verdict: 'pass' }), 'pass of invalid probe');
  });

  it('orders by cross-source wall clock and never claims formal happened-before proof (AC-RUA-002)', () => {
    assertRejected(edited(passing, { ordering_basis: 'happened_before' }), 'formal ordering', '/ordering_basis enum');
    assertRejected(edited(passing, { happened_before_proven: true }), 'proof claim', ' additionalProperties');
    const schema = readFileSync(groupCSchemaPath('transport_probe_result'), 'utf8');
    assert.doesNotMatch(schema, /"happened_before|"formal_order|"proof/);
    assertRejected(
      edited(passing, { fidelity_basis: 'not_applicable' }),
      'probe without basis',
      '/fidelity_basis enum',
    );
    assertRejected(
      edited(passing, { clock_assumption_refs: [] }),
      'assumed without CA-1',
      '/clock_assumption_refs minItems',
    );
  });

  it('is the probe result: no run, validation or trial identity', () => {
    assertForbidden(edited(passing, { run_id: RUN_ID }), 'run identity', '/run_id');
    assertForbidden(edited(passing, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
    assertRejected(edited(passing, { transport_probe_id: undefined }), 'no probe', ' required');
  });
});
