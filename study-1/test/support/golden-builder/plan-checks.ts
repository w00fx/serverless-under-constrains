// Checks that a trial plan describes a run the deployed architecture could produce, so a golden
// case cannot ask the builder for evidence that contradicts its own timeline (a commit after a
// terminal outcome, a Durable step retry after a success, a targeted commit in CONTROL). A fault
// that real evidence could show but the architecture never produces belongs to the scenario
// operations, which edit records after the build, not to the plan.

import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import type { Scenario } from '../../../src/record-contract/primitives.ts';
import { NONEMPTY_TRIMMED_PATTERN } from '../../../src/record-contract/primitives.ts';
import type { AttemptPlan, DeliveryPlan, PlanCaller, TrialPlan } from './golden-plan.ts';
import { isAmbiguousBehavior, isTargetedBehavior } from './golden-plan.ts';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Every reason the plan cannot be built for this caller and scenario; empty when it can.
 *
 * @example
 * checkTrialPlan('conventional', 'CONTROL', defaultTrialPlan('conventional', 'CONTROL')); // []
 */
export function checkTrialPlan(caller: PlanCaller, scenario: Scenario, plan: TrialPlan): readonly string[] {
  const attempts = plan.deliveries.flatMap((delivery) => delivery.attempts);
  return [
    ...deliveryCountProblems(caller, plan),
    ...plan.deliveries.flatMap((delivery, index) => attemptCountProblems(caller, delivery, index + 1)),
    ...attempts.flatMap((attempt, index) => attemptValueProblems(attempt, index + 1)),
    ...terminalPositionProblems(attempts),
    ...targetingProblems(caller, scenario, attempts),
    ...endingProblems(caller, plan),
  ];
}

function deliveryCountProblems(caller: PlanCaller, plan: TrialPlan): readonly string[] {
  const count = plan.deliveries.length;
  if (caller === 'probe' && count !== 1) {
    return [`the probe plan has ${String(count)} invocations; expected exactly 1 (BR-RUA-027)`];
  }
  if (count < 1 || count > 2) {
    return [`the plan has ${String(count)} source deliveries; expected 1 or 2 (maxReceiveCount 2, OR-RUA-002)`];
  }
  return [];
}

function attemptCountProblems(caller: PlanCaller, delivery: DeliveryPlan, position: number): readonly string[] {
  const count = delivery.attempts.length;
  const maximum = caller === 'conventional' ? 1 : 2;
  if (count < 1 || count > maximum) {
    return [
      `delivery ${String(position)} of the ${caller} plan has ${String(count)} attempts; expected 1 to ${String(maximum)}`,
    ];
  }
  return [];
}

function attemptValueProblems(attempt: AttemptPlan, position: number): readonly string[] {
  const label = `attempt ${String(position)}`;
  const problems: string[] = [];
  const amount = attempt.amount_minor;
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 1)) {
    problems.push(`${label} amount_minor ${String(amount)}; expected a safe integer of at least 1`);
  }
  if (attempt.currency !== undefined && !CURRENCY_PATTERN.test(attempt.currency)) {
    problems.push(`${label} currency ${boundedJsonText(attempt.currency)}; expected three uppercase letters`);
  }
  for (const [field, value] of [
    ['refund_request_id', attempt.refund_request_id],
    ['payment_id', attempt.payment_id],
  ] as const) {
    if (value !== undefined && !NONEMPTY_TRIMMED_PATTERN.test(value)) {
      problems.push(`${label} ${field} ${boundedJsonText(value)}; expected text non-empty after trimming`);
    }
  }
  if (attempt.rejection_reason !== undefined && attempt.behavior !== 'rejected') {
    problems.push(`${label} has a rejection_reason with behavior ${attempt.behavior}; expected behavior rejected`);
  }
  return problems;
}

// A success or a provider rejection finishes processing (BR-RUA-022), so nothing may follow it.
function terminalPositionProblems(attempts: readonly AttemptPlan[]): readonly string[] {
  const lastIndex = attempts.length - 1;
  return attempts.flatMap((attempt, index) =>
    !isAmbiguousBehavior(attempt.behavior) && index !== lastIndex
      ? [
          `attempt ${String(index + 1)} is ${attempt.behavior} but attempts follow it; expected it to be the last attempt`,
        ]
      : [],
  );
}

// BR-RUA-025: only the first accepted call of a treatment (or of the probe) is targeted, and
// CONTROL arms nothing.
function targetingProblems(
  caller: PlanCaller,
  scenario: Scenario,
  attempts: readonly AttemptPlan[],
): readonly string[] {
  const treatment = caller === 'probe' || scenario === 'COMMIT_THEN_TIMEOUT';
  const firstAccepted = attempts.findIndex((attempt) => attempt.behavior !== 'rejected');
  return attempts.flatMap((attempt, index) => {
    const label = `attempt ${String(index + 1)} (${attempt.behavior})`;
    if (attempt.behavior === 'untargeted_timeout' && treatment) {
      return [`${label} is an untargeted timeout in a treatment; expected it only in CONTROL`];
    }
    if (isTargetedBehavior(attempt.behavior) && (!treatment || index !== firstAccepted)) {
      return [`${label} is targeted; expected the targeted commit only as the first accepted call of a treatment`];
    }
    if (treatment && index === firstAccepted && !isTargetedBehavior(attempt.behavior)) {
      return [`${label} is the first accepted call of a treatment; expected targeted_timeout or safety_release`];
    }
    return [];
  });
}

// `completes` needs a recorded terminal state: a final success or rejection, or the last retry
// layer exhausted (BR-RUA-024). `active_at_deadline` leaves the last invocation running.
function endingProblems(caller: PlanCaller, plan: TrialPlan): readonly string[] {
  const lastDelivery = plan.deliveries.at(-1);
  const lastAttempt = lastDelivery?.attempts.at(-1);
  if (lastDelivery === undefined || lastAttempt === undefined) {
    return [];
  }
  const problems: string[] = [];
  if (caller === 'durable' && plan.deliveries.length === 2 && plan.deliveries[0]?.attempts.length !== 2) {
    problems.push(
      'the first Durable delivery ends before its step retry; expected two step attempts before a redelivery',
    );
  }
  const ambiguousEnd = isAmbiguousBehavior(lastAttempt.behavior);
  if (plan.processing === 'active_at_deadline') {
    return ambiguousEnd
      ? problems
      : [
          ...problems,
          `the plan ends ${lastAttempt.behavior} but is active at the deadline; expected an ambiguous last attempt`,
        ];
  }
  const exhausted =
    caller === 'probe' ||
    (plan.deliveries.length === 2 && (caller === 'conventional' || lastDelivery.attempts.length === 2));
  if (ambiguousEnd && !exhausted) {
    problems.push(
      'the plan completes after an ambiguous attempt without exhausting its retry layers; expected a retry',
    );
  }
  return problems;
}
