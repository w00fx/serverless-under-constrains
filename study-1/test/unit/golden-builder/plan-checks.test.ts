// The architecture checks on a golden trial plan, and the plan vocabulary: a plan is refused when
// the deployed system could not produce it (retry layers of BR-RUA-020 and OR-RUA-002, terminal
// outcomes of BR-RUA-022, targeting of BR-RUA-025, terminality of BR-RUA-024, the probe of
// BR-RUA-027), and the defaults are the spec's Expected Configured Trace.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTEMPT_BEHAVIORS,
  declaredTrialsOf,
  defaultTrialPlan,
  isAmbiguousBehavior,
  isTargetedBehavior,
} from '../../support/golden-builder/golden-plan.ts';
import type { AttemptBehavior, AttemptPlan, TrialPlan } from '../../support/golden-builder/golden-plan.ts';
import { checkTrialPlan } from '../../support/golden-builder/plan-checks.ts';

const plan = (
  deliveries: readonly (readonly (AttemptBehavior | AttemptPlan)[])[],
  processing: TrialPlan['processing'] = 'completes',
): TrialPlan => ({
  deliveries: deliveries.map((attempts) => ({
    attempts: attempts.map((attempt) => (typeof attempt === 'string' ? { behavior: attempt } : attempt)),
  })),
  processing,
});

describe('plan vocabulary', () => {
  it('classifies behaviors as ambiguous and targeted', () => {
    assert.deepEqual(ATTEMPT_BEHAVIORS.filter(isAmbiguousBehavior), [
      'targeted_timeout',
      'safety_release',
      'untargeted_timeout',
      'commit_failed',
    ]);
    assert.deepEqual(ATTEMPT_BEHAVIORS.filter(isTargetedBehavior), ['targeted_timeout', 'safety_release']);
  });

  it('declares the canonical run order and each validation order (BR-RUA-019, BR-RUA-038)', () => {
    assert.deepEqual(
      declaredTrialsOf('run').map((trial) => `${trial.variant_id}/${trial.scenario}`),
      ['conventional/CONTROL', 'durable/CONTROL', 'conventional/COMMIT_THEN_TIMEOUT', 'durable/COMMIT_THEN_TIMEOUT'],
    );
    assert.deepEqual(
      declaredTrialsOf('validation-conventional').map((trial) => trial.variant_id),
      ['conventional', 'conventional'],
    );
    assert.deepEqual(
      declaredTrialsOf('validation-durable').map((trial) => trial.scenario),
      ['CONTROL', 'COMMIT_THEN_TIMEOUT'],
    );
    assert.deepEqual(declaredTrialsOf('probe'), []);
  });

  it('defaults to the Expected Configured Trace', () => {
    assert.deepEqual(defaultTrialPlan('conventional', 'CONTROL'), plan([['succeeded']]));
    assert.deepEqual(defaultTrialPlan('durable', 'CONTROL'), plan([['succeeded']]));
    assert.deepEqual(
      defaultTrialPlan('conventional', 'COMMIT_THEN_TIMEOUT'),
      plan([['targeted_timeout'], ['succeeded']]),
    );
    assert.deepEqual(defaultTrialPlan('durable', 'COMMIT_THEN_TIMEOUT'), plan([['targeted_timeout', 'succeeded']]));
    assert.deepEqual(defaultTrialPlan('probe', 'COMMIT_THEN_TIMEOUT'), plan([['targeted_timeout']]));
    assert.deepEqual(defaultTrialPlan('probe', 'CONTROL'), plan([['targeted_timeout']]));
  });

  it('accepts every default plan', () => {
    for (const caller of ['conventional', 'durable'] as const) {
      for (const scenario of ['CONTROL', 'COMMIT_THEN_TIMEOUT'] as const) {
        assert.deepEqual(checkTrialPlan(caller, scenario, defaultTrialPlan(caller, scenario)), []);
      }
    }
    assert.deepEqual(
      checkTrialPlan('probe', 'COMMIT_THEN_TIMEOUT', defaultTrialPlan('probe', 'COMMIT_THEN_TIMEOUT')),
      [],
    );
  });
});

describe('checkTrialPlan', () => {
  it('bounds deliveries by maxReceiveCount and the probe by one invocation', () => {
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([])), [
      'the plan has 0 source deliveries; expected 1 or 2 (maxReceiveCount 2, OR-RUA-002)',
    ]);
    assert.ok(
      checkTrialPlan('conventional', 'CONTROL', plan([['commit_failed'], ['commit_failed'], ['succeeded']])).includes(
        'the plan has 3 source deliveries; expected 1 or 2 (maxReceiveCount 2, OR-RUA-002)',
      ),
    );
    assert.deepEqual(checkTrialPlan('probe', 'COMMIT_THEN_TIMEOUT', plan([['targeted_timeout'], ['succeeded']])), [
      'the probe plan has 2 invocations; expected exactly 1 (BR-RUA-027)',
    ]);
  });

  it('bounds attempts per delivery: one conventional, two Durable step attempts or probe attempts', () => {
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['commit_failed', 'succeeded']])), [
      'delivery 1 of the conventional plan has 2 attempts; expected 1 to 1',
    ]);
    assert.deepEqual(checkTrialPlan('durable', 'CONTROL', plan([[]])), [
      'delivery 1 of the durable plan has 0 attempts; expected 1 to 2',
    ]);
    assert.deepEqual(checkTrialPlan('durable', 'CONTROL', plan([['commit_failed', 'commit_failed', 'succeeded']])), [
      'delivery 1 of the durable plan has 3 attempts; expected 1 to 2',
    ]);
    assert.deepEqual(checkTrialPlan('probe', 'COMMIT_THEN_TIMEOUT', plan([['targeted_timeout', 'succeeded']])), []);
  });

  it('checks attempt values', () => {
    const problems = checkTrialPlan(
      'conventional',
      'CONTROL',
      plan([
        [
          {
            behavior: 'succeeded',
            amount_minor: 0,
            currency: 'brl',
            refund_request_id: ' x',
            payment_id: '',
            rejection_reason: 'PAYMENT_NOT_FOUND',
          },
        ],
      ]),
    );
    assert.deepEqual(problems, [
      'attempt 1 amount_minor 0; expected a safe integer of at least 1',
      'attempt 1 currency "brl"; expected three uppercase letters',
      'attempt 1 refund_request_id " x"; expected text non-empty after trimming',
      'attempt 1 payment_id ""; expected text non-empty after trimming',
      'attempt 1 has a rejection_reason with behavior succeeded; expected behavior rejected',
    ]);
    assert.deepEqual(
      checkTrialPlan('conventional', 'CONTROL', plan([[{ behavior: 'succeeded', amount_minor: 1.5 }]])),
      ['attempt 1 amount_minor 1.5; expected a safe integer of at least 1'],
    );
    assert.deepEqual(
      checkTrialPlan(
        'conventional',
        'CONTROL',
        plan([[{ behavior: 'rejected', amount_minor: 1, currency: 'USD', rejection_reason: 'AMOUNT_INVALID' }]]),
      ),
      [],
    );
  });

  it('refuses attempts after a success or a rejection (BR-RUA-022)', () => {
    assert.deepEqual(checkTrialPlan('durable', 'CONTROL', plan([['rejected', 'succeeded']])), [
      'attempt 1 is rejected but attempts follow it; expected it to be the last attempt',
    ]);
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['succeeded'], ['succeeded']])), [
      'attempt 1 is succeeded but attempts follow it; expected it to be the last attempt',
    ]);
  });

  it('targets only the first accepted call of a treatment, and arms nothing in CONTROL (BR-RUA-025)', () => {
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['targeted_timeout'], ['succeeded']])), [
      'attempt 1 (targeted_timeout) is targeted; expected the targeted commit only as the first accepted call of a treatment',
    ]);
    assert.deepEqual(
      checkTrialPlan('conventional', 'COMMIT_THEN_TIMEOUT', plan([['untargeted_timeout'], ['succeeded']])),
      ['attempt 1 (untargeted_timeout) is an untargeted timeout in a treatment; expected it only in CONTROL'],
    );
    assert.deepEqual(checkTrialPlan('conventional', 'COMMIT_THEN_TIMEOUT', plan([['succeeded']])), [
      'attempt 1 (succeeded) is the first accepted call of a treatment; expected targeted_timeout or safety_release',
    ]);
    assert.deepEqual(checkTrialPlan('durable', 'COMMIT_THEN_TIMEOUT', plan([['targeted_timeout', 'safety_release']])), [
      'attempt 2 (safety_release) is targeted; expected the targeted commit only as the first accepted call of a treatment',
      'the plan completes after an ambiguous attempt without exhausting its retry layers; expected a retry',
    ]);
    assert.deepEqual(checkTrialPlan('durable', 'COMMIT_THEN_TIMEOUT', plan([['rejected']])), []);
    assert.deepEqual(checkTrialPlan('probe', 'CONTROL', plan([['untargeted_timeout']])), [
      'attempt 1 (untargeted_timeout) is an untargeted timeout in a treatment; expected it only in CONTROL',
    ]);
  });

  it('requires a Durable step retry before a redelivery', () => {
    assert.deepEqual(checkTrialPlan('durable', 'CONTROL', plan([['commit_failed'], ['succeeded']])), [
      'the first Durable delivery ends before its step retry; expected two step attempts before a redelivery',
    ]);
    assert.deepEqual(
      checkTrialPlan('durable', 'CONTROL', plan([['commit_failed', 'commit_failed'], ['succeeded']])),
      [],
    );
  });

  it('completes after an ambiguous attempt only when every retry layer is exhausted (BR-RUA-024)', () => {
    const unexhausted =
      'the plan completes after an ambiguous attempt without exhausting its retry layers; expected a retry';
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['commit_failed']])), [unexhausted]);
    assert.deepEqual(checkTrialPlan('durable', 'CONTROL', plan([['commit_failed', 'commit_failed']])), [unexhausted]);
    assert.deepEqual(
      checkTrialPlan('durable', 'CONTROL', plan([['commit_failed', 'commit_failed'], ['commit_failed']])),
      [unexhausted],
    );
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['commit_failed'], ['untargeted_timeout']])), []);
    assert.deepEqual(
      checkTrialPlan(
        'durable',
        'CONTROL',
        plan([
          ['commit_failed', 'commit_failed'],
          ['commit_failed', 'commit_failed'],
        ]),
      ),
      [],
    );
    assert.deepEqual(checkTrialPlan('probe', 'COMMIT_THEN_TIMEOUT', plan([['targeted_timeout']])), []);
  });

  it('leaves processing active at the deadline only after an ambiguous attempt', () => {
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['commit_failed']], 'active_at_deadline')), []);
    assert.deepEqual(checkTrialPlan('conventional', 'CONTROL', plan([['succeeded']], 'active_at_deadline')), [
      'the plan ends succeeded but is active at the deadline; expected an ambiguous last attempt',
    ]);
    assert.deepEqual(
      checkTrialPlan('durable', 'CONTROL', plan([['commit_failed'], ['rejected']], 'active_at_deadline')),
      [
        'the first Durable delivery ends before its step retry; expected two step attempts before a redelivery',
        'the plan ends rejected but is active at the deadline; expected an ambiguous last attempt',
      ],
    );
    assert.deepEqual(
      checkTrialPlan('durable', 'CONTROL', plan([['commit_failed'], ['commit_failed']], 'active_at_deadline')),
      ['the first Durable delivery ends before its step retry; expected two step attempts before a redelivery'],
    );
  });
});
