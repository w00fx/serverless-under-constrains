// AC-RUA-046 (group C, rows 70-73): the cross-field rules of the execution summaries and the
// comparison assessment. Each case breaks one rule of a valid example and expects the
// rejection at the member that rule governs.

import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { assertAccepted, assertForbidden, assertRejected } from '../group-b/support/group-b-validation.ts';
import { withValueAt } from '../group-b/support/json-paths.ts';
import { PROBE_ID, RUN_ID, TRIAL_ID, VALIDATION_ID, toJson } from '../group-b/support/record-builders.ts';
import { transportProbeSummary } from './examples/probe-examples.ts';
import {
  eligibleComparison,
  eligibleRunSummary,
  failedValidationSummary,
  incompleteRunSummary,
  indeterminateValidationSummary,
  ineligibleComparison,
  verifiedValidationSummary,
} from './examples/summary-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

const REASONS: JsonValue = [{ code: 'STATUS_REASON', subject: 'summary', detail: 'summary states a reason' }];

function trialAt(summary: JsonValue, index: number, member: string, next: JsonValue | undefined): JsonValue {
  return withValueAt(summary, ['trial_results', index, member], next);
}

describe('AC-RUA-046 validation_summary rules', () => {
  const verified = toJson(verifiedValidationSummary());
  const failed = toJson(failedValidationSummary());
  const indeterminate = toJson(indeterminateValidationSummary());

  it('a conclusive status needs a valid, completed, clean and safe validation (BR-RUA-038)', () => {
    const breaks: readonly (readonly [string, JsonValue])[] = [
      ['validation_validity', 'invalid'],
      ['validation_terminal_reason', 'LEASE_LOST'],
      ['cleanup_status', 'partial'],
      ['leak_audit_status', 'inconclusive'],
      ['lease_status', 'unverified'],
      ['safety_status', 'breached'],
      ['late_evidence_status', 'contradictory'],
      ['late_evidence_status', 'unverified'],
    ];
    for (const [member, value] of breaks) {
      assertRejected(
        edited(verified, { [member]: value }),
        `verified with ${member} ${JSON.stringify(value)}`,
        `/${member}`,
      );
      assertRejected(
        edited(failed, { [member]: value }),
        `failed with ${member} ${JSON.stringify(value)}`,
        `/${member}`,
      );
    }
  });

  it('verified means control pass with a conclusive treatment and no reason', () => {
    assertRejected(edited(verified, { status_reasons: REASONS }), 'verified with reasons', '/status_reasons maxItems');
    assertRejected(
      trialAt(trialAt(verified, 0, 'preservation_verdict', 'fail'), 0, 'correct_completion', false),
      'verified after control fail',
      '/trial_results/0/preservation_verdict enum',
    );
    assertRejected(
      trialAt(trialAt(verified, 1, 'preservation_verdict', 'indeterminate'), 1, 'correct_completion', null),
      'verified with indeterminate treatment',
      '/trial_results/1/preservation_verdict enum',
    );
    assertAccepted(
      trialAt(trialAt(verified, 1, 'preservation_verdict', 'fail'), 1, 'correct_completion', false),
      'verified with failing treatment',
    );
  });

  it('failed means a trustworthy control fail, with its reasons', () => {
    assertRejected(edited(failed, { status_reasons: [] }), 'failed without reasons', '/status_reasons minItems');
    assertRejected(
      trialAt(trialAt(failed, 0, 'preservation_verdict', 'pass'), 0, 'correct_completion', true),
      'failed after control pass',
      '/trial_results/0/preservation_verdict enum',
    );
    // Design §8.15: an indeterminate treatment verdict makes the status indeterminate, not failed.
    assertRejected(
      trialAt(trialAt(failed, 1, 'preservation_verdict', 'indeterminate'), 1, 'correct_completion', null),
      'failed with an indeterminate treatment',
      '/trial_results/1/preservation_verdict enum',
    );
    assertAccepted(
      trialAt(trialAt(failed, 1, 'preservation_verdict', 'pass'), 1, 'correct_completion', true),
      'failed with a passing treatment',
    );
  });

  it('indeterminate states its reasons and may have any closure', () => {
    assertRejected(
      edited(indeterminate, { status_reasons: [] }),
      'indeterminate without reasons',
      '/status_reasons minItems',
    );
    assertAccepted(edited(indeterminate, { safety_status: 'breached' }), 'indeterminate after a breach');
  });

  it('holds one variant, CONTROL then COMMIT_THEN_TIMEOUT, and no run identity', () => {
    const trials = arrayAt(verified, 'trial_results');
    assertRejected(
      trialAt(verified, 1, 'variant_id', 'conventional'),
      'mixed variants',
      '/trial_results/1/variant_id const',
    );
    assertRejected(
      edited(verified, { trial_results: trials.toReversed() }),
      'treatment first',
      '/trial_results/0/sequence const',
    );
    assertRejected(edited(verified, { trial_results: trials.slice(0, 1) }), 'one trial', '/trial_results minItems');
    assertForbidden(edited(verified, { run_id: RUN_ID }), 'run identity', '/run_id');
    assertForbidden(edited(verified, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
    assertRejected(edited(verified, { winner: 'durable' }), 'cross-variant field', ' additionalProperties');
  });
});

describe('AC-RUA-046 summary trial results (CTR-RUA-002, D-29)', () => {
  const eligible = toJson(eligibleRunSummary());
  const incomplete = toJson(incompleteRunSummary());

  it('a completed trial has an oracle-result reference with its verdict and completion', () => {
    assertRejected(
      trialAt(eligible, 0, 'oracle_result_ref', undefined),
      'completed without result',
      '/trial_results/0',
    );
    assertRejected(
      trialAt(eligible, 0, 'preservation_verdict', undefined),
      'reference without verdict',
      '/trial_results/0 dependentRequired',
    );
    assertRejected(
      trialAt(eligible, 0, 'correct_completion', undefined),
      'reference without completion',
      '/trial_results/0 dependentRequired',
    );
  });

  it('a trial without an oracle result states why, and carries no verdict', () => {
    assertRejected(
      trialAt(incomplete, 3, 'incompletion_reasons', []),
      'unexplained incomplete trial',
      '/trial_results/3/incompletion_reasons minItems',
    );
    assertRejected(
      trialAt(incomplete, 3, 'preservation_verdict', 'fail'),
      'verdict without result',
      '/trial_results/3 dependentRequired',
    );
    assertRejected(
      trialAt(incomplete, 3, 'correct_completion', null),
      'completion without result',
      '/trial_results/3 dependentRequired',
    );
    assertRejected(
      trialAt(incomplete, 3, 'execution_status', 'completed'),
      'completed without result',
      '/trial_results/3',
    );
  });

  it('correct_completion follows the trial verdict', () => {
    assertRejected(
      trialAt(eligible, 2, 'correct_completion', true),
      'fail but correct',
      '/trial_results/2/correct_completion const',
    );
    assertRejected(
      trialAt(eligible, 0, 'correct_completion', null),
      'pass with null',
      '/trial_results/0/correct_completion enum',
    );
    assertRejected(
      trialAt(incomplete, 1, 'correct_completion', false),
      'indeterminate false',
      '/trial_results/1/correct_completion const',
    );
    assertAccepted(trialAt(eligible, 3, 'correct_completion', true), 'pass and correct');
  });
});

describe('AC-RUA-046 run_summary rules', () => {
  const eligible = toJson(eligibleRunSummary());
  const incomplete = toJson(incompleteRunSummary());

  it('eligible exactly when there is no ineligibility reason', () => {
    assertRejected(
      edited(eligible, { comparison_ineligibility_reasons: REASONS }),
      'eligible with reasons',
      '/comparison_ineligibility_reasons maxItems',
    );
    assertRejected(
      edited(incomplete, { comparison_ineligibility_reasons: [] }),
      'ineligible without reasons',
      '/comparison_ineligibility_reasons minItems',
    );
  });

  it('lists exactly four trials in the BR-RUA-019 order, never filtered or reordered (AC-RUA-012)', () => {
    const trials = arrayAt(eligible, 'trial_results');
    const [first, second, ...rest] = trials;
    assertRejected(
      edited(eligible, { trial_results: [second ?? null, first ?? null, ...rest] }),
      'swapped controls',
      '/trial_results/0/sequence const',
    );
    assertRejected(edited(eligible, { trial_results: trials.slice(0, 3) }), 'filtered', '/trial_results minItems');
    assertRejected(trialAt(eligible, 2, 'variant_id', 'durable'), 'wrong variant', '/trial_results/2/variant_id const');
    assertRejected(
      trialAt(eligible, 1, 'scenario', 'COMMIT_THEN_TIMEOUT'),
      'wrong scenario',
      '/trial_results/1/scenario const',
    );
    assertRejected(trialAt(eligible, 0, 'rank', 1), 'annotated trial', '/trial_results/0 additionalProperties');
  });

  it('has no winner, aggregate, ranking or statistic', () => {
    for (const member of ['winner', 'aggregate_verdict', 'ranking', 'pass_rate']) {
      assertRejected(edited(eligible, { [member]: 'durable' }), member, ' additionalProperties');
    }
  });

  it('names the run only', () => {
    assertForbidden(
      edited(eligible, { variant_validation_id: VALIDATION_ID }),
      'validation identity',
      '/variant_validation_id',
    );
    assertForbidden(edited(eligible, { transport_probe_id: PROBE_ID }), 'probe identity', '/transport_probe_id');
    assertRejected(edited(eligible, { run_id: undefined }), 'no run', ' required');
  });
});

describe('AC-RUA-046 comparison_assessment rules', () => {
  const eligible = toJson(eligibleComparison());
  const ineligible = toJson(ineligibleComparison());
  const timing = ['equality_projections', 6];

  it('eligible exactly when every condition holds and no reason is stated (BR-RUA-052)', () => {
    assertRejected(
      withValueAt(eligible, ['eligibility_checks', 4, 'holds'], false),
      'eligible with failing check',
      '/eligibility_checks/4/holds const',
    );
    assertRejected(
      edited(eligible, { comparison_ineligibility_reasons: REASONS }),
      'eligible with reasons',
      '/comparison_ineligibility_reasons maxItems',
    );
    assertRejected(
      withValueAt(ineligible, ['eligibility_checks', 4, 'holds'], true),
      'ineligible but all hold',
      '/eligibility_checks contains',
    );
    assertRejected(
      edited(ineligible, { comparison_ineligibility_reasons: [] }),
      'ineligible without reasons',
      '/comparison_ineligibility_reasons minItems',
    );
  });

  it('a projection fails only on an undeclared difference (BR-RUA-031)', () => {
    assertRejected(
      withValueAt(eligible, [...timing, 'differences', 0, 'declared'], false),
      'pass with undeclared difference',
      '/equality_projections/6/differences/0/declared const',
    );
    assertRejected(
      withValueAt(ineligible, [...timing, 'differences', 0, 'declared'], true),
      'fail with declared difference',
      '/equality_projections/6/differences contains',
    );
    assertRejected(
      withValueAt(eligible, [...timing, 'differences', 0, 'values'], []),
      'difference without values',
      '/equality_projections/6/differences/0/values minItems',
    );
    assertRejected(
      withValueAt(eligible, [...timing, 'compared_fields'], []),
      'nothing compared',
      '/equality_projections/6/compared_fields minItems',
    );
    assertRejected(
      withValueAt(eligible, [...timing, 'compared_fields'], ['/a', '/a']),
      'duplicate field',
      '/equality_projections/6/compared_fields uniqueItems',
    );
  });

  it('equality passes only when every projection passes', () => {
    assertRejected(
      edited(ineligible, { equality_result: 'pass' }),
      'pass over a failed projection',
      '/equality_projections/6/result const',
    );
    assertRejected(
      withValueAt(eligible, [...timing, 'result'], 'indeterminate'),
      'pass over an indeterminate projection',
      '/equality_projections/6/result const',
    );
    const undecided = withValueAt(
      edited(ineligible, { equality_result: 'indeterminate' }),
      [...timing, 'result'],
      'indeterminate',
    );
    assertAccepted(undecided, 'an indeterminate projection leaves equality indeterminate');
  });

  it('lists the eight projections and nine checks in their fixed order, over at most four results', () => {
    const projections = arrayAt(eligible, 'equality_projections');
    const checks = arrayAt(eligible, 'eligibility_checks');
    const refs = arrayAt(eligible, 'oracle_result_refs');
    assertRejected(
      edited(eligible, { equality_projections: projections.toReversed() }),
      'reversed projections',
      '/equality_projections/0/projection_id const',
    );
    assertRejected(
      edited(eligible, { eligibility_checks: checks.slice(1) }),
      'eight checks',
      '/eligibility_checks minItems',
    );
    assertRejected(
      edited(eligible, { oracle_result_refs: [...refs, refs[0] ?? null] }),
      'five results',
      '/oracle_result_refs maxItems',
    );
    assertForbidden(
      edited(eligible, { variant_validation_id: VALIDATION_ID }),
      'validation comparison',
      '/variant_validation_id',
    );
  });
});

describe('AC-RUA-046 transport_probe_summary rules', () => {
  const summary = toJson(transportProbeSummary());

  it('belongs to the probe and uses the probe terminal reasons', () => {
    assertForbidden(edited(summary, { run_id: RUN_ID }), 'run identity', '/run_id');
    assertForbidden(edited(summary, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
    assertRejected(
      edited(summary, { probe_terminal_reason: 'TRIAL_INCOMPLETE' }),
      'run reason',
      '/probe_terminal_reason enum',
    );
    assertAccepted(
      edited(summary, { probe_terminal_reason: 'PROBE_INCOMPLETE', cleanup_status: 'failed' }),
      'incomplete probe',
    );
  });

  it('carries the probe-result digest when COMPLETED; a probe that froze no result omits it', () => {
    assertRejected(edited(summary, { probe_result_sha256: undefined }), 'COMPLETED without digest', ' required');
    for (const reason of ['LEASE_ACQUISITION_FAILED', 'PROVISIONING_FAILED', 'PROBE_INCOMPLETE']) {
      assertAccepted(
        edited(summary, { probe_terminal_reason: reason, probe_result_sha256: undefined }),
        `${reason} without digest`,
      );
    }
    assertAccepted(edited(summary, { probe_terminal_reason: 'CLEANUP_INCOMPLETE' }), 'frozen result, failed cleanup');
    assertRejected(
      edited(summary, { probe_terminal_reason: 'LEASE_ACQUISITION_FAILED', probe_result_sha256: 'A'.repeat(64) }),
      'malformed digest',
      '/probe_result_sha256',
    );
  });
});
