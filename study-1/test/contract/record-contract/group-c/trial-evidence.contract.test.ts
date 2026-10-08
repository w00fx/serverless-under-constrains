// AC-RUA-046 (group C, rows 66 and 68): the cross-field rules of the derived trial evidence
// (the oracle result of row 67 and the probe result of row 69 have their own files). Each
// case breaks one rule of a valid example and expects the rejection at the member that rule
// governs; the accepted cases pin the branch the rule deliberately leaves open.

import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import {
  assertAccepted,
  assertForbidden,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import { withValueAt } from '../../../support/record-contract/json-paths.ts';
import {
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  VALIDATION_ID,
  toJson,
} from '../../../support/record-contract/record-builders.ts';
import {
  attemptProjection,
  durableAttemptProjection,
  probeAttemptProjection,
  probeEvidenceIndex,
  trialEvidenceIndex,
} from './examples/trial-evidence-examples.ts';
import { arrayAt, edited, recordWithValueAt } from './support/json-edits.ts';

describe('AC-RUA-046 attempt_projection rules', () => {
  const trial = toJson(attemptProjection());
  const probe = toJson(probeAttemptProjection());
  const durable = toJson(durableAttemptProjection());

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

  it('an outcome implies its dispatch state and its outcome class (BR-RUA-021, BR-RUA-022)', () => {
    const attempt = ['attempts', 0];
    const at = (member: string, value: string | undefined): ReturnType<typeof withValueAt> =>
      withValueAt(trial, [...attempt, member], value);
    const both = (outcome: string, dispatch: string, outcomeClass: string): ReturnType<typeof withValueAt> =>
      withValueAt(
        withValueAt(withValueAt(trial, [...attempt, 'outcome'], outcome), [...attempt, 'dispatch_state'], dispatch),
        [...attempt, 'outcome_class'],
        outcomeClass,
      );
    const dispatchedClasses = [
      ['SUCCEEDED', 'SUCCESS'],
      ['REJECTED', 'REJECTION'],
      ['TIMED_OUT', 'AMBIGUOUS'],
    ] as const;
    for (const [outcome, outcomeClass] of dispatchedClasses) {
      assertAccepted(both(outcome, 'DISPATCHED', outcomeClass), `${outcome} is ${outcomeClass}`);
      for (const dispatch of ['NOT_DISPATCHED', 'UNKNOWN']) {
        assertRejected(
          both(outcome, dispatch, outcomeClass),
          `${outcome} with dispatch ${dispatch}`,
          '/attempts/0/dispatch_state const',
        );
      }
    }
    assertRejected(
      both('SUCCEEDED', 'DISPATCHED', 'AMBIGUOUS'),
      'SUCCEEDED as AMBIGUOUS',
      '/attempts/0/outcome_class const',
    );
    assertRejected(both('REJECTED', 'DISPATCHED', 'SUCCESS'), 'REJECTED as SUCCESS', '/attempts/0/outcome_class const');
    assertRejected(
      both('TIMED_OUT', 'DISPATCHED', 'REJECTION'),
      'TIMED_OUT as REJECTION',
      '/attempts/0/outcome_class const',
    );
    assertAccepted(both('FAILED', 'NOT_DISPATCHED', 'PRE_DISPATCH_FAILURE'), 'FAILED before dispatch');
    assertRejected(
      both('FAILED', 'NOT_DISPATCHED', 'AMBIGUOUS'),
      'FAILED before dispatch as AMBIGUOUS',
      '/attempts/0/outcome_class const',
    );
    for (const dispatch of ['DISPATCHED', 'UNKNOWN']) {
      assertAccepted(both('FAILED', dispatch, 'AMBIGUOUS'), `FAILED ${dispatch} is AMBIGUOUS`);
      assertRejected(
        both('FAILED', dispatch, 'PRE_DISPATCH_FAILURE'),
        `FAILED ${dispatch} as a pre-dispatch failure`,
        '/attempts/0/outcome_class const',
      );
    }
    // Design §8.5: a dispatched attempt without a recorded outcome counts as ambiguous.
    assertAccepted(at('outcome', undefined), 'dispatched without outcome, AMBIGUOUS');
    assertRejected(
      withValueAt(at('outcome', undefined), [...attempt, 'outcome_class'], 'SUCCESS'),
      'dispatched without outcome as SUCCESS',
      '/attempts/0/outcome_class const',
    );
    assertRejected(
      withValueAt(at('outcome', undefined), [...attempt, 'outcome_class'], 'PRE_DISPATCH_FAILURE'),
      'pre-dispatch failure that was dispatched',
      '/attempts/0/dispatch_state const',
    );
  });

  it('an attempt without an outcome is never a success or a rejection (BR-RUA-021)', () => {
    const attempt = ['attempts', 0];
    const noOutcome = (dispatch: string, outcomeClass: string): JsonObject =>
      recordWithValueAt(
        recordWithValueAt(
          recordWithValueAt(trial, [...attempt, 'outcome'], undefined),
          [...attempt, 'dispatch_state'],
          dispatch,
        ),
        [...attempt, 'outcome_class'],
        outcomeClass,
      );
    for (const dispatch of ['DISPATCHED', 'UNKNOWN', 'NOT_DISPATCHED']) {
      for (const outcomeClass of ['SUCCESS', 'REJECTION']) {
        assertRejected(
          noOutcome(dispatch, outcomeClass),
          `${dispatch} without outcome as ${outcomeClass}`,
          '/attempts/0/outcome_class enum',
        );
      }
    }
    assertAccepted(noOutcome('UNKNOWN', 'AMBIGUOUS'), 'UNKNOWN dispatch without outcome is AMBIGUOUS');
  });

  it('an ambiguous attempt derives UNKNOWN knowledge, the BR-RUA-022 Ambiguous column', () => {
    const knowledge = ['attempts', 0, 'knowledge_after_derived'];
    for (const derived of [
      'NOT_ATTEMPTED',
      'NO_EFFECT_CONFIRMED',
      'ONE_EFFECT_CONFIRMED',
      'MULTIPLE_EFFECTS_CONFIRMED',
    ]) {
      assertRejected(
        recordWithValueAt(trial, knowledge, derived),
        `AMBIGUOUS attempt deriving ${derived}`,
        '/attempts/0/knowledge_after_derived const',
      );
    }
    // A pre-dispatch failure from NOT_ATTEMPTED stays NOT_ATTEMPTED (the probe example).
    assertAccepted(probe, 'pre-dispatch failure keeps NOT_ATTEMPTED');
    assertAccepted(
      recordWithValueAt(probe, knowledge, 'ONE_EFFECT_CONFIRMED'),
      'later rows of the table are the oracle fold, not a per-attempt schema rule',
    );
  });

  it('only a Durable caller invocation carries Durable execution metadata', () => {
    const invocation = ['attempts', 0, 'invocation'];
    assertAccepted(durable, 'Durable step attempt');
    for (const source of ['conventional_caller', 'probe_caller']) {
      assertForbidden(
        recordWithValueAt(durable, [...invocation, 'source'], source),
        `${source} with a Durable execution ARN`,
        '/attempts/0/invocation/durable_execution_arn',
      );
      assertForbidden(
        recordWithValueAt(
          recordWithValueAt(durable, [...invocation, 'source'], source),
          [...invocation, 'durable_execution_arn'],
          undefined,
        ),
        `${source} with a step attempt`,
        '/attempts/0/invocation/step_attempt',
      );
    }
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

  it('classifies the addendum §2.2 readiness evidence (warm-up and canary partitions)', () => {
    for (const artifactClass of ['provider_warmup_journal', 'caller_canary_journal', 'controller_canary_journal']) {
      assertAccepted(withValueAt(trial, ['entries', 0, 'artifact_class'], artifactClass), artifactClass);
    }
    assertRejected(
      withValueAt(trial, ['entries', 0, 'artifact_class'], 'warmup_journal'),
      'unknown readiness class',
      '/entries/0/artifact_class enum',
    );
  });
});
