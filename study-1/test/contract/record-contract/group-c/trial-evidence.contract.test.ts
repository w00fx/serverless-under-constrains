// AC-RUA-046 (group C, rows 66-69): the cross-field rules of the derived trial evidence. Each
// case breaks one rule of a valid example and expects the rejection at the member that rule
// governs; the accepted cases pin the branch the rule deliberately leaves open.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_SCHEMA_ROOT } from '../../../../src/record-contract/schema-registry.ts';
import { assertAccepted, assertForbidden, assertRejected } from '../group-b/support/group-b-validation.ts';
import { withValueAt } from '../group-b/support/json-paths.ts';
import {
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  VALIDATION_ID,
  toJson,
} from '../group-b/support/record-builders.ts';
import {
  attemptProjection,
  controlPassOracleResult,
  indeterminateOracleResult,
  probeAttemptProjection,
  probeEvidenceIndex,
  treatmentPassOracleResult,
  trialEvidenceIndex,
} from './examples/trial-evidence-examples.ts';
import { invalidTransportProbeResult, passingTransportProbeResult } from './examples/probe-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

describe('AC-RUA-046 attempt_projection rules', () => {
  const trial = toJson(attemptProjection());
  const probe = toJson(probeAttemptProjection());

  it('a trial projection names its trial pair; a probe projection names none', () => {
    assertRejected(edited(trial, { trial_manifest_sha256: undefined }), 'trial without manifest', ' dependentRequired');
    assertRejected(edited(trial, { trial_id: undefined }), 'manifest without trial', ' dependentRequired');
    assertForbidden(
      edited(probe, { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA256 }),
      'probe trial',
      '/trial_id',
    );
    assertAccepted(
      edited(trial, { trial_id: undefined, trial_manifest_sha256: undefined }),
      'execution-level projection',
    );
  });

  it('names exactly one execution identity', () => {
    assertRejected(edited(trial, { variant_validation_id: VALIDATION_ID }), 'run and validation', ' oneOf');
    assertRejected(edited(trial, { run_id: undefined, trial_id: undefined, trial_manifest_sha256: undefined }), 'none');
  });

  it('a provider call carries exactly the members of its disposition', () => {
    const accepted = ['provider_calls', 0];
    const rejected = ['provider_calls', 1];
    const unresolved = ['provider_calls', 2];
    assertRejected(
      withValueAt(trial, [...accepted, 'attempt_id'], undefined),
      'ACCEPTED without attempt',
      '/provider_calls/0 required',
    );
    assertForbidden(
      withValueAt(trial, [...accepted, 'rejection_reason'], 'AMOUNT_INVALID'),
      'ACCEPTED with rejection',
      '/provider_calls/0/rejection_reason',
    );
    assertRejected(
      withValueAt(trial, [...rejected, 'rejection_reason'], undefined),
      'REJECTED without reason',
      '/provider_calls/1 required',
    );
    assertForbidden(
      withValueAt(trial, [...rejected, 'attempt_id'], RUN_ID),
      'REJECTED with attempt',
      '/provider_calls/1/attempt_id',
    );
    assertForbidden(
      withValueAt(trial, [...unresolved, 'rejection_reason'], 'AMOUNT_INVALID'),
      'UNRESOLVED with reason',
      '/provider_calls/2/rejection_reason',
    );
    assertForbidden(
      withValueAt(trial, [...unresolved, 'provider_request_id'], RUN_ID),
      'UNRESOLVED with request',
      '/provider_calls/2/provider_request_id',
    );
  });

  it('transactions reference the ledger snapshot and never copy it', () => {
    assertRejected(
      withValueAt(trial, ['transactions', 0, 'ledger_ref'], undefined),
      'no ledger ref',
      '/transactions/0 required',
    );
    assertRejected(
      withValueAt(trial, ['transactions', 0, 'ledger_items'], []),
      'copied ledger',
      '/transactions/0 additionalProperties',
    );
  });
});

describe('AC-RUA-046 oracle_result rules', () => {
  const control = toJson(controlPassOracleResult());
  const treatment = toJson(treatmentPassOracleResult());
  const indeterminate = toJson(indeterminateOracleResult());

  it('a pass or fail needs a valid trial; a non-valid trial is indeterminate (BR-RUA-006)', () => {
    assertRejected(
      edited(control, { trial_validity: 'indeterminate' }),
      'pass of an indeterminate trial',
      '/trial_validity const',
    );
    assertRejected(
      edited(control, { preservation_verdict: 'fail', correct_completion: false, trial_validity: 'invalid' }),
      'fail of an invalid trial',
      '/trial_validity const',
    );
    assertAccepted(edited(indeterminate, { trial_validity: 'invalid' }), 'indeterminate invalid trial');
    assertAccepted(edited(indeterminate, { trial_validity: 'valid' }), 'indeterminate valid trial');
  });

  it('correct_completion follows the verdict and the terminal reason (BR-RUA-030, D-17)', () => {
    assertRejected(
      edited(control, { correct_completion: false }),
      'SUCCEEDED pass not correct',
      '/correct_completion const',
    );
    assertRejected(
      edited(control, { correct_completion: null }),
      'pass with null completion',
      '/correct_completion const',
    );
    assertRejected(
      edited(treatment, { correct_completion: true }),
      'exhausted pass correct',
      '/correct_completion const',
    );
    assertRejected(edited(control, { preservation_verdict: 'fail' }), 'fail correct', '/correct_completion const');
    assertRejected(
      edited(control, { preservation_verdict: 'fail', correct_completion: null }),
      'fail null',
      '/correct_completion const',
    );
    assertRejected(
      edited(indeterminate, { correct_completion: false }),
      'indeterminate false',
      '/correct_completion const',
    );
    assertRejected(
      edited(indeterminate, { correct_completion: true }),
      'indeterminate true',
      '/correct_completion const',
    );
  });

  it('a pass always has a terminal reason; fail and indeterminate may have none', () => {
    assertRejected(
      edited(control, { processing_terminal_reason: null }),
      'pass without reason',
      '/processing_terminal_reason enum',
    );
    assertAccepted(
      edited(control, { preservation_verdict: 'fail', correct_completion: false, processing_terminal_reason: null }),
      'fail without reason',
    );
    assertAccepted(edited(indeterminate, { processing_terminal_reason: 'INTERRUPTED' }), 'indeterminate with reason');
    assertRejected(
      edited(control, { processing_terminal_reason: 'TIMED_OUT' }),
      'unknown reason',
      '/processing_terminal_reason enum',
    );
  });

  it('a CONTROL trial has no treatment assessment (D-05)', () => {
    assertRejected(
      edited(control, { control_integrity: 'not_applicable' }),
      'control without integrity',
      '/control_integrity enum',
    );
    assertRejected(
      edited(control, { treatment_fidelity: 'verified' }),
      'control fidelity',
      '/treatment_fidelity const',
    );
    assertRejected(edited(control, { fidelity_basis: 'causal' }), 'control basis', '/fidelity_basis const');
    assertRejected(
      edited(control, { clock_assumption_refs: ['CA-1'] }),
      'control clock',
      '/clock_assumption_refs maxItems',
    );
    assertRejected(
      edited(control, { treatment_condition_results: treatment['treatment_condition_results'] }),
      'control conditions',
      '/treatment_condition_results maxItems',
    );
  });

  it('a treatment trial has six ordered conditions and a fidelity basis', () => {
    const conditions = arrayAt(treatment, 'treatment_condition_results');
    assertRejected(
      edited(treatment, { control_integrity: 'verified' }),
      'treatment control integrity',
      '/control_integrity const',
    );
    assertRejected(
      edited(treatment, { treatment_fidelity: 'not_applicable' }),
      'treatment fidelity n/a',
      '/treatment_fidelity enum',
    );
    assertRejected(
      edited(treatment, { fidelity_basis: 'not_applicable' }),
      'treatment basis n/a',
      '/fidelity_basis enum',
    );
    assertRejected(
      edited(treatment, { treatment_condition_results: conditions.slice(1) }),
      'five conditions',
      '/treatment_condition_results minItems',
    );
    assertRejected(
      edited(treatment, { treatment_condition_results: conditions.toReversed() }),
      'reversed conditions',
      '/treatment_condition_results/0/condition_id const',
    );
  });

  it('a clock-assumption basis names its assumption (CA-1)', () => {
    assertRejected(
      edited(treatment, { clock_assumption_refs: [] }),
      'assumed without CA-1',
      '/clock_assumption_refs minItems',
    );
    assertRejected(
      edited(treatment, { clock_assumption_refs: ['CA-1', 'CA-1'] }),
      'duplicate CA-1',
      '/clock_assumption_refs uniqueItems',
    );
    assertAccepted(edited(indeterminate, { clock_assumption_refs: ['CA-1'] }), 'causal basis may cite CA-1');
  });

  it('lists the nine gates and the ten rules in their fixed order', () => {
    const gates = arrayAt(control, 'validity_gates');
    const rules = arrayAt(control, 'rule_results');
    assertRejected(edited(control, { validity_gates: gates.slice(0, 8) }), 'eight gates', '/validity_gates minItems');
    assertRejected(
      edited(control, { validity_gates: [...gates.slice(1), gates[0] ?? null] }),
      'rotated gates',
      '/validity_gates/0/gate const',
    );
    assertRejected(
      edited(control, { rule_results: [...rules, rules[0] ?? null] }),
      'eleven rules',
      '/rule_results maxItems',
    );
    assertRejected(
      edited(control, { rule_results: rules.toReversed() }),
      'reversed rules',
      '/rule_results/0/rule_id const',
    );
  });

  it('names a run or a variant validation, never a probe', () => {
    assertRejected(edited(control, { variant_validation_id: VALIDATION_ID }), 'both executions', ' oneOf');
    assertRejected(edited(control, { run_id: undefined }), 'no execution', ' oneOf');
    assertForbidden(edited(control, { transport_probe_id: PROBE_ID }), 'probe oracle result', '/transport_probe_id');
  });
});

describe('AC-RUA-046 evidence_index rules', () => {
  const trial = toJson(trialEvidenceIndex());
  const probe = toJson(probeEvidenceIndex());
  const entries = arrayAt(trial, 'entries');
  const withPath = (path: string): ReturnType<typeof withValueAt> =>
    withValueAt(trial, ['entries', entries.length - 1, 'artifact_path'], path);

  it('a TRIAL index names its trial and its run or validation; a PROBE index names the probe only (D-06)', () => {
    assertRejected(edited(trial, { trial_id: undefined }), 'trial index without trial', ' required');
    assertForbidden(edited(trial, { transport_probe_id: PROBE_ID }), 'trial index of a probe', '/transport_probe_id');
    assertRejected(edited(trial, { variant_validation_id: VALIDATION_ID }), 'trial index of two executions', ' oneOf');
    assertAccepted(
      edited(trial, { run_id: undefined, variant_validation_id: VALIDATION_ID }),
      'validation trial index',
    );
    assertForbidden(
      edited(probe, { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA256 }),
      'probe index with trial',
      '/trial_id',
    );
    assertForbidden(edited(probe, { run_id: RUN_ID }), 'probe index of a run', '/run_id');
    assertRejected(edited(probe, { transport_probe_id: undefined }), 'probe index without probe', ' required');
  });

  it('lists at least one entry, sorted by path, without duplicates', () => {
    assertRejected(edited(trial, { entries: [] }), 'empty index', '/entries minItems');
    assertRejected(edited(trial, { entries: entries.toReversed() }), 'unsorted', '/entries x-rua-evidence-ref-order');
    assertRejected(
      edited(trial, { entries: [entries[0] ?? null, ...entries] }),
      'duplicate',
      '/entries x-rua-evidence-ref-order',
    );
  });

  it('never lists itself, another evidence index or the late-evidence area', () => {
    // The first entry is replaced by a path that still sorts first, the last by one that still
    // sorts last, so only the exclusion patterns can reject them.
    const last = `/entries/${String(entries.length - 1)}/artifact_path`;
    assertRejected(withPath('trials/z/evidence-index.json'), 'another trial index', `${last} not`);
    assertRejected(
      withValueAt(trial, ['entries', 0, 'artifact_path'], 'evidence-index.json'),
      'root index',
      '/entries/0/artifact_path not',
    );
    assertRejected(
      withValueAt(trial, ['entries', 0, 'artifact_path'], 'late-evidence/late-evidence-stream.jsonl'),
      'late evidence',
      '/entries/0/artifact_path not',
    );
    assertAccepted(withPath('trials/z/pre-evidence-index.json'), 'a name that only ends with the index name');
    assertAccepted(withPath('trials/z/evidence-index.json.sha256'), 'a sibling of an index');
    assertAccepted(withPath('trials/z/late-evidence/notes.json'), 'a nested directory named late-evidence');
  });
});

describe('AC-RUA-046 transport_probe_result rules', () => {
  const passing = toJson(passingTransportProbeResult());
  const invalid = toJson(invalidTransportProbeResult());

  it('a pass needs a valid probe, verified evidence and six passing conditions (CTR-RUA-003)', () => {
    assertRejected(
      edited(passing, { probe_validity: 'indeterminate' }),
      'pass of indeterminate probe',
      '/probe_validity const',
    );
    assertRejected(
      edited(passing, { evidence_integrity: 'unverified' }),
      'pass of unverified evidence',
      '/evidence_integrity const',
    );
    assertRejected(
      withValueAt(passing, ['condition_results', 2, 'result'], 'fail'),
      'pass with failed condition',
      '/condition_results/2/result const',
    );
    assertAccepted(edited(passing, { transport_probe_verdict: 'fail' }), 'fail of a valid probe');
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
    assertRejected(edited(passing, { happened_before_proven: true }), 'proof claim', ' unevaluatedProperties');
    const schema = readFileSync(join(DEFAULT_SCHEMA_ROOT, 'group-c', 'transport_probe_result.schema.json'), 'utf8');
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
