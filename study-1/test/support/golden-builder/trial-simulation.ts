// One trial's processing after publication: source deliveries (conventional), Durable executions
// with their step attempts, or the probe's single invocation, each attempt followed by the
// version-conditioned request state (design §5.3 `RequestStateRecorder`). Retry timing follows
// OR-RUA-002: a failed conventional delivery reappears when its 60 s visibility expires, a Durable
// step retries 60 s after its failure, and a failed Durable execution's message reappears after
// 360 s. Each redelivery is received 400 ms after it becomes visible.

import { decideTerminality } from '../../../src/attempt-lifecycle/terminality.ts';
import { nextEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import type { EffectKnowledge } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { simulateAttempt } from './attempt-simulation.ts';
import { linkSha256 } from './digest-links.ts';
import type { AttemptEnvironment, AttemptResult } from './attempt-run.ts';
import { GoldenEventLog } from './golden-event-log.ts';
import type { GoldenSourceInstance } from './golden-event-log.ts';
import type { AttemptPlan, DeliveryPlan, TrialPlan } from './golden-plan.ts';
import {
  FINANCIAL_FIXTURE,
  GOLDEN_ACCOUNT_ID,
  GOLDEN_CALLER_VERSION,
  GOLDEN_TIMING,
  goldenUuid,
  instantAt,
} from './golden-values.ts';
import { EXECUTION_MANIFEST_PATH, SLOT_OFFSETS, publishedMs } from './trial-context.ts';
import type { TrialContext } from './trial-context.ts';
import { TrialTimeline } from './trial-timeline.ts';
import type { DurableHistoryFact } from './trial-timeline.ts';

/** A redelivery (or the first delivery) is received this long after the message becomes visible. */
export const RECEIVE_DELAY_MS = 400;
type HistoryWriter = (eventType: string, atMs: number, details?: JsonObject) => void;

/** A caller dispatches its attempt this long after its invocation starts. */
export const DISPATCH_AFTER_START_MS = 40;

/** The simulated trial: its partition events and the facts the observer reads. */
export interface SimulatedTrial {
  readonly log: GoldenEventLog;
  readonly timeline: TrialTimeline;
  /** The probe's single invocation, which the runner records as `probe_workload_invoked`. */
  readonly probe_invocation?: { readonly lambda_request_id: string; readonly ended_ms: number };
}

type Processing =
  | { readonly processing_state: 'RUNNING' }
  | { readonly processing_state: 'FINISHED'; readonly processing_terminal_reason: string };

/** The request-level state the recorder folds across attempts. */
interface RequestProgress {
  knowledge: EffectKnowledge;
  version: number;
  readonly attempt_ids: Uuid4[];
  attempts: number;
}

interface DeliveryRun {
  readonly env: AttemptEnvironment;
  readonly plan: TrialPlan;
  readonly progress: RequestProgress;
  readonly delivery: DeliveryPlan;
  /** 1-based; also the SQS ApproximateReceiveCount of the delivery. */
  readonly receive_count: number;
  readonly received_ms: number;
  readonly last: boolean;
}

/**
 * The SQS message id of the trial message.
 *
 * @example
 * messageIdOf(context); // a lowercase UUID, stable per trial label
 */
export function messageIdOf(context: TrialContext): string {
  return goldenUuid(`${context.label}/message_id`);
}

/**
 * Runs the plan of one trial (or of the probe) on the golden timeline.
 *
 * @example
 * const trial = simulateTrial(context, defaultTrialPlan('conventional', 'CONTROL'));
 * trial.timeline.ledgerAt(Number.MAX_SAFE_INTEGER).length; // 1
 */
export function simulateTrial(context: TrialContext, plan: TrialPlan): SimulatedTrial {
  const log = new GoldenEventLog({
    label: context.label,
    identity: context.execution.identity,
    execution_manifest_sha256: linkSha256(EXECUTION_MANIFEST_PATH),
    ...(context.trial === undefined ? {} : { trial: context.trial }),
  });
  const timeline = new TrialTimeline();
  let controller: GoldenSourceInstance | undefined;
  const env: AttemptEnvironment = {
    context,
    log,
    timeline,
    controller: () => (controller ??= log.instance('treatment_controller', 'controller')),
  };
  if (context.caller === 'probe' || context.scenario === 'COMMIT_THEN_TIMEOUT') {
    timeline.addTreatment(context.slot_ms + SLOT_OFFSETS.treatment_armed, { state: 'ARMED', version: 1 });
  }
  const progress: RequestProgress = { knowledge: 'NOT_ATTEMPTED', version: 0, attempt_ids: [], attempts: 0 };
  if (context.caller === 'probe') {
    return { log, timeline, probe_invocation: runProbe(env, plan, progress) };
  }
  let visibleMs = publishedMs(context);
  for (const [index, delivery] of plan.deliveries.entries()) {
    const receivedMs = visibleMs + RECEIVE_DELAY_MS;
    timeline.addQueueSpan({ state: 'visible', from_ms: visibleMs, until_ms: receivedMs });
    const run: DeliveryRun = {
      env,
      plan,
      progress,
      delivery,
      receive_count: index + 1,
      received_ms: receivedMs,
      last: index === plan.deliveries.length - 1,
    };
    const next = context.caller === 'conventional' ? runConventionalDelivery(run) : runDurableDelivery(run);
    if (next === undefined) {
      break;
    }
    visibleMs = next;
  }
  return { log, timeline };
}

// Returns when the message becomes visible again, or undefined when it never does.
function runConventionalDelivery(run: DeliveryRun): number | undefined {
  const caller = run.env.log.instance('conventional_caller', `delivery-${String(run.receive_count)}`);
  const started = caller.emit('caller_invocation_started', run.received_ms, {
    lambda_request_id: lambdaRequestId(run.env, `delivery-${String(run.receive_count)}`),
    message_id: messageIdOf(run.env.context),
    approximate_receive_count: run.receive_count,
  });
  const plan = firstAttempt(run.delivery);
  const attempt = runAttempt(run, caller, started, plan, run.received_ms + DISPATCH_AFTER_START_MS);
  const processing = conventionalProcessing(run, attempt);
  const stateMs = recordRequestState(run, caller, attempt, processing);
  return releaseMessage(run, processing, stateMs + 10, GOLDEN_TIMING.conventional_visibility_timeout_ms);
}

function conventionalProcessing(run: DeliveryRun, attempt: AttemptResult): Processing {
  if (attempt.outcome_class !== 'AMBIGUOUS') {
    return finishedFor(attempt);
  }
  if (run.last && run.plan.processing === 'active_at_deadline') {
    return { processing_state: 'RUNNING' };
  }
  const decision = decideTerminality({
    variant: 'conventional',
    receive_count: run.receive_count,
    max_receive_count: GOLDEN_TIMING.max_receive_count,
    attempt_ambiguous_or_failed: true,
  });
  return decision.processing_state === 'RUNNING'
    ? { processing_state: 'RUNNING' }
    : { processing_state: 'FINISHED', processing_terminal_reason: decision.terminal_reason };
}

function runDurableDelivery(run: DeliveryRun): number | undefined {
  const label = `delivery-${String(run.receive_count)}`;
  const name = goldenUuid(`${run.env.context.label}/${label}/durable_execution_name`);
  const executionId = goldenUuid(`${run.env.context.label}/${label}/durable_execution_id`);
  const arn = `${durableFunctionArn(run.env.context)}:${GOLDEN_CALLER_VERSION}/durable-execution/${name}/${executionId}`;
  const history: DurableHistoryFact[] = [];
  const historyAt: HistoryWriter = (eventType, atMs, details = {}) => {
    const event = { history_event_id: history.length + 1, event_type: eventType, event_timestamp: instantAt(atMs) };
    history.push({ at_ms: atMs, event: { ...event, ...details } });
  };
  historyAt('ExecutionStarted', run.received_ms);
  let startMs = run.received_ms + 10;
  let processing: Processing = { processing_state: 'RUNNING' };
  let endMs = startMs;
  for (const [index, plan] of run.delivery.attempts.entries()) {
    const step = index + 1;
    const invocation = `${label}/invocation-${String(step)}`;
    const requestId = lambdaRequestId(run.env, invocation);
    const caller = run.env.log.instance('durable_caller', invocation);
    const started = caller.emit('caller_invocation_started', startMs, {
      lambda_request_id: requestId,
      message_id: messageIdOf(run.env.context),
      approximate_receive_count: run.receive_count,
      durable_execution_arn: arn,
      step_attempt: step,
    });
    historyAt('StepStarted', startMs + 30, { name: 'refund-attempt', current_attempt: step });
    const attempt = runAttempt(run, caller, started, plan, startMs + DISPATCH_AFTER_START_MS);
    const exhausted = attempt.outcome_class === 'AMBIGUOUS' && step === 2;
    processing = durableProcessing(run, attempt, exhausted);
    const stateMs = recordRequestState(run, caller, attempt, processing);
    if (exhausted) {
      recordExhaustion(caller, stateMs + 5, { arn, receive_count: run.receive_count, attempt });
    }
    recordStepHistory(historyAt, attempt, step, stateMs, requestId);
    endMs = stateMs + 20;
    startMs = stateMs + 10 + GOLDEN_TIMING.durable_retry_delay_ms;
  }
  const status = durableStatus(run, processing);
  if (status !== 'RUNNING') {
    historyAt(status === 'SUCCEEDED' ? 'ExecutionSucceeded' : 'ExecutionFailed', endMs);
  }
  run.env.timeline.addDurableExecution({
    arn,
    name,
    started_ms: run.received_ms,
    ...(status === 'RUNNING' ? {} : { end: { at_ms: endMs, status } }),
    history,
  });
  return releaseMessage(run, processing, endMs, GOLDEN_TIMING.durable_visibility_timeout_ms);
}

// BR-RUA-024: both step attempts of one Durable execution failed ambiguously.
function recordExhaustion(
  caller: GoldenSourceInstance,
  atMs: number,
  exhaustion: { readonly arn: string; readonly receive_count: number; readonly attempt: AttemptResult },
): void {
  caller.emit(
    'inner_execution_exhausted',
    atMs,
    {
      refund_request_id: FINANCIAL_FIXTURE.refund_request_id,
      durable_execution_arn: exhaustion.arn,
      step_attempts: 2,
      approximate_receive_count: exhaustion.receive_count,
      last_attempt_id: exhaustion.attempt.attempt_id,
    },
    [exhaustion.attempt.outcome_event_id],
  );
}

function durableProcessing(run: DeliveryRun, attempt: AttemptResult, exhausted: boolean): Processing {
  if (attempt.outcome_class !== 'AMBIGUOUS') {
    return finishedFor(attempt);
  }
  if (run.last && run.plan.processing === 'active_at_deadline') {
    return { processing_state: 'RUNNING' };
  }
  const decision = decideTerminality({
    variant: 'durable',
    receive_count: run.receive_count,
    max_receive_count: GOLDEN_TIMING.max_receive_count,
    inner_execution_exhausted: exhausted,
  });
  return decision.processing_state === 'RUNNING'
    ? { processing_state: 'RUNNING' }
    : { processing_state: 'FINISHED', processing_terminal_reason: decision.terminal_reason };
}

function durableStatus(run: DeliveryRun, processing: Processing): 'RUNNING' | 'SUCCEEDED' | 'FAILED' {
  if (run.last && run.plan.processing === 'active_at_deadline') {
    return 'RUNNING';
  }
  const reason = processing.processing_state === 'FINISHED' ? processing.processing_terminal_reason : undefined;
  return reason === 'SUCCEEDED' || reason === 'PROVIDER_REJECTED' ? 'SUCCEEDED' : 'FAILED';
}

function recordStepHistory(
  historyAt: HistoryWriter,
  attempt: AttemptResult,
  step: number,
  stateMs: number,
  requestId: string,
): void {
  if (attempt.outcome_class !== 'AMBIGUOUS') {
    historyAt('StepSucceeded', stateMs + 5, { name: 'refund-attempt', current_attempt: step });
  } else {
    historyAt('StepFailed', stateMs + 5, {
      name: 'refund-attempt',
      current_attempt: step,
      ...(step === 1 ? { next_attempt_delay_seconds: GOLDEN_TIMING.durable_retry_delay_ms / 1000 } : {}),
      error_type: 'StepError',
    });
  }
  historyAt('InvocationCompleted', stateMs + 10, { request_id: requestId });
}

// The message leaves the source when processing finishes; otherwise it reappears when its
// visibility expires, and after the last receive the redrive policy moves it to the DLQ.
function releaseMessage(
  run: DeliveryRun,
  processing: Processing,
  doneMs: number,
  visibilityMs: number,
): number | undefined {
  const timeline = run.env.timeline;
  if (run.last && run.plan.processing === 'active_at_deadline') {
    timeline.addQueueSpan({ state: 'in_flight', from_ms: run.received_ms });
    return undefined;
  }
  const reason = processing.processing_state === 'FINISHED' ? processing.processing_terminal_reason : undefined;
  if (reason === 'SUCCEEDED' || reason === 'PROVIDER_REJECTED') {
    timeline.addQueueSpan({ state: 'in_flight', from_ms: run.received_ms, until_ms: doneMs });
    return undefined;
  }
  const visibleMs = run.received_ms + visibilityMs;
  timeline.addQueueSpan({ state: 'in_flight', from_ms: run.received_ms, until_ms: visibleMs });
  if (run.receive_count >= GOLDEN_TIMING.max_receive_count) {
    timeline.addQueueSpan({ state: 'visible', from_ms: visibleMs, until_ms: visibleMs + RECEIVE_DELAY_MS });
    timeline.moveToDlq(visibleMs + RECEIVE_DELAY_MS);
    return undefined;
  }
  return run.last ? undefined : visibleMs;
}

function runProbe(
  env: AttemptEnvironment,
  plan: TrialPlan,
  progress: RequestProgress,
): { readonly lambda_request_id: string; readonly ended_ms: number } {
  const caller = env.log.instance('probe_caller', 'invocation');
  const startedMs = publishedMs(env.context);
  const requestId = lambdaRequestId(env, 'probe-invocation');
  const started = caller.emit('caller_invocation_started', startedMs, { lambda_request_id: requestId });
  let dispatchMs = startedMs + DISPATCH_AFTER_START_MS;
  let endedMs = dispatchMs;
  for (const attemptPlan of plan.deliveries.flatMap((delivery) => delivery.attempts)) {
    progress.attempts += 1;
    const attempt = simulateAttempt(env, {
      plan: attemptPlan,
      number: progress.attempts,
      caller,
      invocation_event_id: started,
      dispatch_ms: dispatchMs,
    });
    endedMs = attempt.outcome_ms + 10;
    dispatchMs = attempt.outcome_ms + DISPATCH_AFTER_START_MS;
  }
  return { lambda_request_id: requestId, ended_ms: endedMs };
}

function runAttempt(
  run: DeliveryRun,
  caller: GoldenSourceInstance,
  invocationEventId: Uuid4,
  plan: AttemptPlan,
  dispatchMs: number,
): AttemptResult {
  run.progress.attempts += 1;
  return simulateAttempt(run.env, {
    plan,
    number: run.progress.attempts,
    caller,
    invocation_event_id: invocationEventId,
    dispatch_ms: dispatchMs,
  });
}

// The version-conditioned request item and its event (BR-RUA-022): knowledge folds the outcome
// class through the BR-RUA-022 table, and the item lists every attempt so far.
function recordRequestState(
  run: DeliveryRun,
  caller: GoldenSourceInstance,
  attempt: AttemptResult,
  processing: Processing,
): number {
  const progress = run.progress;
  progress.knowledge = nextEffectKnowledge(progress.knowledge, attempt.outcome_class);
  progress.version += 1;
  progress.attempt_ids.push(attempt.attempt_id);
  const stateMs = attempt.outcome_ms + 10;
  caller.emit(
    'request_state_recorded',
    stateMs,
    {
      refund_request_id: FINANCIAL_FIXTURE.refund_request_id,
      version: progress.version,
      effect_knowledge: progress.knowledge,
      attempt_ids: [...progress.attempt_ids],
      ...processing,
    },
    [attempt.outcome_event_id],
  );
  if (processing.processing_state === 'FINISHED') {
    run.env.timeline.addFinished(stateMs);
  }
  return stateMs;
}

function finishedFor(attempt: AttemptResult): Processing {
  return {
    processing_state: 'FINISHED',
    processing_terminal_reason: attempt.outcome_class === 'SUCCESS' ? 'SUCCEEDED' : 'PROVIDER_REJECTED',
  };
}

function firstAttempt(delivery: DeliveryPlan): AttemptPlan {
  const plan = delivery.attempts[0];
  if (plan === undefined) {
    throw new RangeError('a delivery has no attempts; expected a plan that passed checkTrialPlan');
  }
  return plan;
}

function lambdaRequestId(env: AttemptEnvironment, label: string): string {
  return goldenUuid(`${env.context.label}/${label}/lambda_request_id`);
}

/**
 * The unqualified ARN of the Durable caller function of an execution.
 *
 * @example
 * durableFunctionArn(context); // 'arn:aws:lambda:us-east-1:012345678901:function:suc1-<p>-durable-caller'
 */
export function durableFunctionArn(context: TrialContext): string {
  return `arn:aws:lambda:us-east-1:${GOLDEN_ACCOUNT_ID}:function:suc1-${context.execution.resource_prefix}-durable-caller`;
}
