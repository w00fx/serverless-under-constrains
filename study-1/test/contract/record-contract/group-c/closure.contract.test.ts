// AC-RUA-046 (group C, rows 74-78 and 85): the cross-field rules of operational closure and late
// evidence. Each case breaks one rule of a valid example and expects the rejection at the
// member that rule governs.

import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { assertAccepted, assertForbidden, assertRejected } from '../group-b/support/group-b-validation.ts';
import { withValueAt } from '../group-b/support/json-paths.ts';
import { PROBE_ID, RUN_ID, TRIAL_ID, TRIAL_MANIFEST_SHA256, at, toJson } from '../group-b/support/record-builders.ts';
import {
  breachedSafety,
  cleanLeakAudit,
  contradictoryLateEvidence,
  correlatedLateRecord,
  inconclusiveLeakAudit,
  leakingAudit,
  operationalRecovery,
  partialCleanup,
  quietLateEvidence,
  runningCleanup,
  skippedLateEvidence,
  succeededCleanup,
  uncorrelatedProbeLateRecord,
  unverifiedSafety,
  withinLimitsSafety,
} from './examples/closure-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

const REASONS: JsonValue = [{ code: 'CLOSURE_REASON', subject: 'closure', detail: 'closure states a reason' }];

describe('AC-RUA-046 safety_assessment rules (BR-RUA-046)', () => {
  const within = toJson(withinLimitsSafety());
  const unverified = toJson(unverifiedSafety());
  const breached = toJson(breachedSafety());

  it('derives the status with precedence breached > unverified > within_limits', () => {
    assertRejected(
      withValueAt(within, ['checks', 1, 'result'], 'breached'),
      'within with a breach',
      '/checks/1/result const',
    );
    assertRejected(edited(within, { reasons: REASONS }), 'within with reasons', '/reasons maxItems');
    assertRejected(
      withValueAt(breached, ['checks', 0, 'result'], 'within_limits'),
      'breached without a breach',
      '/checks contains',
    );
    assertRejected(
      edited(unverified, { checks: [...arrayAt(unverified, 'checks'), arrayAt(breached, 'checks')[0] ?? null] }),
      'unverified with a breach',
      '/checks/1/result enum',
    );
    assertRejected(
      edited(unverified, { checks: arrayAt(within, 'checks') }),
      'unverified with every check within',
      '/checks contains',
    );
  });

  it('a decided check states its observed value; an unverified one may lack it', () => {
    assertRejected(
      withValueAt(within, ['checks', 0, 'observed'], undefined),
      'within without observed',
      '/checks/0 required',
    );
    assertRejected(
      withValueAt(breached, ['checks', 0, 'observed'], undefined),
      'breached without observed',
      '/checks/0 required',
    );
    assertAccepted(withValueAt(unverified, ['checks', 0, 'observed'], 'unknown'), 'unverified with observed');
  });

  it('has at least one check and no trial identity', () => {
    assertRejected(edited(within, { checks: [] }), 'no checks', '/checks minItems');
    assertForbidden(edited(within, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
  });
});

describe('AC-RUA-046 cleanup_result rules (BR-RUA-048..051)', () => {
  const succeeded = toJson(succeededCleanup());
  const partial = toJson(partialCleanup());
  const running = toJson(runningCleanup());

  it('never deletes an ambiguous or baseline resource, and deletes only owned ones', () => {
    assertRejected(
      withValueAt(succeeded, ['resources', 2, 'ownership_basis'], 'recorded_stack'),
      'skipped owned',
      '/resources/2/ownership_basis const',
    );
    assertRejected(
      withValueAt(succeeded, ['resources', 2, 'action'], 'DELETED'),
      'deleted ambiguous',
      '/resources/2/ownership_basis enum',
    );
    assertRejected(
      withValueAt(succeeded, ['resources', 3, 'action'], 'DELETED'),
      'deleted baseline',
      '/resources/3/ownership_basis enum',
    );
    assertRejected(
      withValueAt(succeeded, ['resources', 0, 'action'], 'EXCLUDED_BASELINE'),
      'excluded owned',
      '/resources/0/ownership_basis const',
    );
  });

  it('succeeded means no deletion failed; partial means one did', () => {
    assertRejected(
      withValueAt(succeeded, ['resources', 0, 'action'], 'DELETE_FAILED'),
      'succeeded with failure',
      '/resources/0/action not',
    );
    assertRejected(
      withValueAt(partial, ['resources', 0, 'action'], 'DELETED'),
      'partial without failure',
      '/resources contains',
    );
    assertAccepted(edited(partial, { cleanup_status: 'failed' }), 'failed cleanup');
  });

  it('a terminal cleanup has a completion time; a running one has none', () => {
    assertRejected(edited(succeeded, { completed_at: undefined }), 'succeeded without completion', ' required');
    assertRejected(
      edited(partial, { cleanup_status: 'failed', completed_at: undefined }),
      'failed without completion',
      ' required',
    );
    assertForbidden(edited(running, { completed_at: at(5300) }), 'running with completion', '/completed_at');
    assertAccepted(edited(running, { cleanup_status: 'not_started', steps: [] }), 'not started cleanup');
  });

  it('numbers steps 1-12 and lists unique stopped executions and deleted messages', () => {
    assertRejected(withValueAt(succeeded, ['steps', 0, 'step'], 13), 'step 13', '/steps/0/step maximum');
    assertRejected(withValueAt(succeeded, ['steps', 0, 'step'], 0), 'step 0', '/steps/0/step minimum');
    assertRejected(
      edited(succeeded, { deleted_dlq_message_ids: ['m', 'm'] }),
      'duplicate message',
      '/deleted_dlq_message_ids uniqueItems',
    );
    assertRejected(
      edited(succeeded, { stopped_durable_execution_arns: ['a', 'a'] }),
      'duplicate execution',
      '/stopped_durable_execution_arns uniqueItems',
    );
  });
});

describe('AC-RUA-046 leak_audit_result rules (BR-RUA-051, BR-RUA-052, D-30)', () => {
  const clean = toJson(cleanLeakAudit());
  const leaking = toJson(leakingAudit());
  const inconclusive = toJson(inconclusiveLeakAudit());
  const firstSurface = ['passes', 0, 'surfaces', 0];

  it('clean needs two complete, empty passes and 120000 ms of stable absence', () => {
    assertRejected(edited(clean, { passes: arrayAt(clean, 'passes').slice(1) }), 'one pass', '/passes minItems');
    assertRejected(
      edited(clean, { stable_absence_interval_ms: 119999 }),
      'short absence',
      '/stable_absence_interval_ms minimum',
    );
    assertRejected(
      withValueAt(clean, [...firstSurface, 'observed'], ['rua-provider']),
      'observed resource',
      '/passes/0/surfaces/0/observed maxItems',
    );
    assertRejected(
      withValueAt(clean, [...firstSurface, 'query_ok'], false),
      'failed query',
      '/passes/0/surfaces/0/query_ok const',
    );
    assertRejected(edited(clean, { leaks: arrayAt(leaking, 'leaks') }), 'clean with a leak', '/leaks maxItems');
    assertRejected(
      edited(clean, { ambiguous: arrayAt(inconclusive, 'ambiguous') }),
      'clean with ambiguity',
      '/ambiguous maxItems',
    );
  });

  it('leaks_detected needs a leak, every query successful and nothing ambiguous', () => {
    assertRejected(edited(leaking, { leaks: [] }), 'no leak', '/leaks minItems');
    assertRejected(
      withValueAt(leaking, [...firstSurface, 'query_ok'], false),
      'failed query',
      '/passes/0/surfaces/0/query_ok const',
    );
    assertRejected(
      edited(leaking, { ambiguous: arrayAt(inconclusive, 'ambiguous') }),
      'ambiguous resource',
      '/ambiguous maxItems',
    );
  });

  it('inconclusive needs a failed query, an ambiguous resource or fewer than two passes', () => {
    const settled = edited(inconclusive, { passes: arrayAt(clean, 'passes'), ambiguous: [] });
    assertRejected(settled, 'inconclusive without a cause', ' anyOf');
    assertAccepted(edited(settled, { passes: arrayAt(clean, 'passes').slice(1) }), 'inconclusive after one pass');
    assertAccepted(edited(inconclusive, { ambiguous: [] }), 'inconclusive after a failed query');
    assertAccepted(edited(settled, { ambiguous: arrayAt(inconclusive, 'ambiguous') }), 'inconclusive with ambiguity');
  });

  it('an ambiguous resource states why; a leak is owned and classified', () => {
    assertRejected(
      withValueAt(inconclusive, ['ambiguous', 0, 'reasons'], []),
      'unexplained ambiguity',
      '/ambiguous/0/reasons minItems',
    );
    assertRejected(
      withValueAt(leaking, ['leaks', 0, 'ownership_basis'], 'ambiguous'),
      'ambiguous leak',
      '/leaks/0/ownership_basis enum',
    );
    assertRejected(
      withValueAt(leaking, ['leaks', 0, 'capability_class'], 'compute'),
      'unknown class',
      '/leaks/0/capability_class enum',
    );
  });
});

describe('AC-RUA-046 late_evidence_record rules (BR-RUA-043)', () => {
  const correlated = toJson(correlatedLateRecord());
  const probe = toJson(uncorrelatedProbeLateRecord());

  it('a trial pair names the correlated trial; a probe stream names no trial', () => {
    assertRejected(edited(correlated, { correlated: false }), 'trial but uncorrelated', '/correlated const');
    assertRejected(
      edited(correlated, { trial_manifest_sha256: undefined }),
      'trial without manifest',
      ' dependentRequired',
    );
    assertForbidden(
      edited(probe, { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA256, correlated: true }),
      'probe trial',
      '/trial_id',
    );
    assertAccepted(edited(probe, { correlated: true }), 'a probe record correlated with the probe');
    assertAccepted(
      edited(correlated, { trial_id: undefined, trial_manifest_sha256: undefined, correlated: false }),
      'uncorrelated run record',
    );
  });

  it('carries the late record as a catalogued JSON object of the named type', () => {
    assertRejected(
      edited(correlated, { late_record: { record_type: 'dlq_snapshot' } }),
      'no version',
      '/late_record required',
    );
    assertRejected(edited(correlated, { late_record: { schema_version: 1 } }), 'no type', '/late_record required');
    assertRejected(edited(correlated, { late_record: '{}' }), 'serialized record', '/late_record type');
    assertRejected(
      edited(correlated, { late_record_type: 'Provider_Commit' }),
      'cased type',
      '/late_record_type pattern',
    );
    assertRejected(edited(correlated, { sequence: 0 }), 'sequence 0', '/sequence minimum');
    assertRejected(edited(correlated, { run_id: undefined }), 'no execution', ' oneOf');
  });
});

describe('AC-RUA-046 late_evidence_assessment rules (BR-RUA-043, D-16)', () => {
  const quiet = toJson(quietLateEvidence());
  const contradictory = toJson(contradictoryLateEvidence());
  const skipped = toJson(skippedLateEvidence());

  it('unverified exactly when monitoring was not complete, with reasons', () => {
    assertRejected(
      edited(quiet, { late_evidence_status: 'unverified' }),
      'complete but unverified',
      '/late_evidence_status enum',
    );
    for (const monitoring of ['shortened', 'skipped', 'failed']) {
      assertRejected(
        edited(quiet, { monitoring, reasons: REASONS }),
        `${monitoring} but none`,
        '/late_evidence_status const',
      );
    }
    assertRejected(edited(skipped, { reasons: [] }), 'unverified without reasons', '/reasons minItems');
    const shortened = edited(skipped, {
      monitoring: 'shortened',
      monitoring_started_at: at(7000),
      monitoring_ended_at: at(8000),
    });
    assertAccepted(shortened, 'shortened monitoring window');
    assertAccepted(edited(shortened, { monitoring_ended_at: undefined }), 'monitoring that never ended');
  });

  it('a complete monitoring states its window; a skipped one has none', () => {
    assertRejected(
      edited(quiet, { monitoring_started_at: undefined, monitoring_ended_at: undefined }),
      'complete without window',
      ' required',
    );
    assertRejected(edited(quiet, { monitoring_ended_at: undefined }), 'complete without end', ' required');
    assertForbidden(
      edited(skipped, { monitoring_started_at: at(7000) }),
      'skipped with start',
      '/monitoring_started_at',
    );
    assertRejected(
      edited(skipped, { monitoring: 'failed', monitoring_ended_at: at(7000) }),
      'end without start',
      ' dependentRequired',
    );
  });

  it('none means no correlated record and no change', () => {
    assertRejected(
      edited(quiet, { correlated_record_count: 1 }),
      'none with a record',
      '/correlated_record_count const',
    );
    assertRejected(
      withValueAt(quiet, ['reassessments', 0, 'status'], 'consistent'),
      'none with consistent',
      '/reassessments/0/status const',
    );
  });

  it('consistent and contradictory have at least one correlated record (D-16)', () => {
    assertRejected(
      edited(contradictory, { correlated_record_count: 0 }),
      'contradictory without a record',
      '/correlated_record_count minimum',
    );
    assertRejected(
      edited(contradictory, { late_evidence_status: 'consistent', correlated_record_count: 0, reassessments: [] }),
      'consistent without a record',
      '/correlated_record_count minimum',
    );
    assertAccepted(
      edited(contradictory, { late_evidence_status: 'consistent', correlated_record_count: 1, reassessments: [] }),
      'consistent with one record',
    );
  });

  it('contradictory needs a reassessment that changed the verdict projection', () => {
    assertRejected(
      withValueAt(contradictory, ['reassessments', 0, 'status'], 'consistent'),
      'no contradiction',
      '/reassessments',
    );
    assertRejected(
      edited(contradictory, { late_evidence_status: 'consistent' }),
      'consistent over a contradiction',
      '/reassessments/0/status enum',
    );
    assertRejected(
      withValueAt(contradictory, ['reassessments', 0, 'changes'], []),
      'contradiction without change',
      '/reassessments/0/changes minItems',
    );
    const change: JsonValue = { field: '/preservation_verdict', frozen: 'pass', reassessed: 'pass' };
    assertRejected(
      withValueAt(contradictory, ['reassessments', 1, 'changes'], [change]),
      'consistent with change',
      '/reassessments/1/changes maxItems',
    );
    assertRejected(
      withValueAt(contradictory, ['reassessments', 0, 'changes', 0, 'field'], ''),
      'root field',
      '/reassessments/0/changes/0/field minLength',
    );
    assertRejected(
      withValueAt(contradictory, ['reassessments', 0, 'changes', 0, 'field'], 'verdict'),
      'not a pointer',
      '/reassessments/0/changes/0/field pattern',
    );
    assertAccepted(
      withValueAt(contradictory, ['reassessments', 0, 'changes', 0, 'reassessed'], { verdict: null }),
      'any reassessed value',
    );
  });

  it('is execution-level', () => {
    assertForbidden(edited(quiet, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
    assertRejected(edited(quiet, { transport_probe_id: PROBE_ID }), 'two executions', ' oneOf');
  });
});

describe('AC-RUA-046 operational_recovery_record rules (BR-RUA-038)', () => {
  const recovery = toJson(operationalRecovery());

  it('reruns only cleanup steps 3-11, each once', () => {
    assertRejected(edited(recovery, { steps_run: [2, 3] }), 'step 2', '/steps_run/0 minimum');
    assertRejected(edited(recovery, { steps_run: [3, 12] }), 'step 12', '/steps_run/1 maximum');
    assertRejected(edited(recovery, { steps_run: [3, 3] }), 'step twice', '/steps_run uniqueItems');
    assertRejected(edited(recovery, { steps_run: [] }), 'no step', '/steps_run minItems');
  });

  it('records only the terminal cleanup, leak-audit and lease closure', () => {
    assertRejected(
      withValueAt(recovery, ['recovered_closure', 'cleanup_status'], 'running'),
      'running cleanup',
      '/recovered_closure/cleanup_status enum',
    );
    assertRejected(
      withValueAt(recovery, ['recovered_closure', 'safety_status'], 'within_limits'),
      'safety repaired',
      '/recovered_closure additionalProperties',
    );
    assertRejected(
      edited(recovery, { comparison_eligibility: 'eligible' }),
      'scientific repair',
      ' unevaluatedProperties',
    );
    assertForbidden(edited(recovery, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
    assertRejected(edited(recovery, { run_id: RUN_ID }), 'two executions', ' oneOf');
  });
});
