// The settlement observer over a simulated trial (BR-RUA-032, design §8.12 and D-32). Samples are
// taken every 30 s from publication until a quiet 120 s window is followed by a quiet pre-freeze
// recheck 5 s later, or until the 600 s deadline (OR-RUA-002; the probe uses the same values,
// OR-RUA-004 stabilization 120 s). Each sample is a query over the trial timeline, and the
// assessment applies the §8.12 evaluator to exactly those samples, so the runner's
// `settlement_assessed` and a re-derivation from the frozen samples always agree.

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { SettlementRestartCause } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { GOLDEN_TIMING, instantAt } from './golden-values.ts';
import { messageIdOf } from './trial-simulation.ts';
import type { SimulatedTrial } from './trial-simulation.ts';
import { publishedMs } from './trial-context.ts';
import type { TrialContext } from './trial-context.ts';
import { eventsAtOrBefore } from './trial-timeline.ts';
import type { CounterValues } from './trial-timeline.ts';

/** The pre-freeze recheck follows the end of the quiet window by this much (D-32). */
export const RECHECK_AFTER_MS = 5000;

/** One settlement sample's own fields; the trial correlation is added when the file is built. */
export interface SampleFields {
  readonly observed_at_ms: number;
  readonly fields: JsonObject;
}

/** The observer's result and the instants the collector works from. */
export interface SettlementOutcome {
  readonly samples: readonly SampleFields[];
  /** The `settlement_assessed` fields after the envelope. */
  readonly assessment: JsonObject;
  readonly assessed_ms: number;
  /** Established: the end of the quiet window; otherwise the deadline. Snapshots are taken after it. */
  readonly capture_ms: number;
  /** When the observer first captured the trial message from the DLQ, if it did. */
  readonly dlq_captured_ms?: number;
}

interface Sample {
  readonly observed_at_ms: number;
  readonly phase: 'observation' | 'pre_freeze_recheck';
  readonly processing_terminal: boolean;
  readonly inner_executions_terminal: boolean | 'not_applicable';
  readonly provider_active_calls: number;
  readonly provider_held_barriers: number;
  readonly provider_pending_releases: number;
  readonly treatment_terminal: boolean | 'not_applicable';
  readonly source_queue: CounterValues | 'not_applicable';
  readonly dlq: CounterValues | 'not_applicable';
  readonly correlated_dlq_message_ids: readonly string[];
  readonly dlq_captured_message_ids: readonly string[];
  readonly correlated_event_watermark: number;
  readonly ledger_item_count: number;
}

/**
 * Observes a simulated trial until settlement is established or the deadline passes.
 *
 * @example
 * const settlement = observeSettlement(context, trial);
 * settlement.assessment['status']; // 'established' for every Expected Configured Trace plan
 */
export function observeSettlement(context: TrialContext, trial: SimulatedTrial): SettlementOutcome {
  const published = publishedMs(context);
  const deadline = published + GOLDEN_TIMING.observation_deadline_ms;
  const samples: Sample[] = [];
  const restarts: JsonObject[] = [];
  let previous: Sample | undefined;
  let windowStart: number | undefined;
  let lastCauses: readonly SettlementRestartCause[] = [];
  let lastCausesAt = published;
  const interval = GOLDEN_TIMING.queue_poll_interval_ms;
  for (let at = published + interval; at <= deadline; at += interval) {
    const sample = sampleAt(context, trial, at, 'observation');
    samples.push(sample);
    const causes = causesOf(sample, previous);
    const [restartCause] = causes;
    previous = sample;
    if (restartCause !== undefined) {
      restarts.push({ at: instantAt(at), cause: restartCause });
      [windowStart, lastCauses, lastCausesAt] = [undefined, causes, at];
      continue;
    }
    windowStart ??= at;
    const recheckAt = at + RECHECK_AFTER_MS;
    if (at - windowStart < GOLDEN_TIMING.stabilization_interval_ms || recheckAt > deadline) {
      continue;
    }
    const recheck = sampleAt(context, trial, recheckAt, 'pre_freeze_recheck');
    samples.push(recheck);
    const recheckCauses = causesOf(recheck, sample);
    previous = recheck;
    if (recheckCauses.length === 0) {
      return established(samples, restarts, windowStart, at, recheckAt);
    }
    restarts.push({ at: instantAt(recheckAt), cause: 'PRE_FREEZE_ACTIVITY' });
    [windowStart, lastCauses, lastCausesAt] = [undefined, recheckCauses, recheckAt];
  }
  return notEstablished(samples, restarts, deadline, lastCauses, lastCausesAt);
}

function established(
  samples: readonly Sample[],
  restarts: readonly JsonObject[],
  windowStart: number,
  quietUntil: number,
  recheckAt: number,
): SettlementOutcome {
  return {
    samples: samples.map(sampleFields),
    assessment: {
      status: 'established',
      window_start: instantAt(windowStart),
      established_at: instantAt(quietUntil),
      rechecked_at: instantAt(recheckAt),
      reasons: [],
      restarts: [...restarts],
      sample_count: samples.length,
    },
    assessed_ms: recheckAt + 1000,
    capture_ms: quietUntil,
    ...dlqCapture(samples),
  };
}

function notEstablished(
  samples: readonly Sample[],
  restarts: readonly JsonObject[],
  deadline: number,
  lastCauses: readonly SettlementRestartCause[],
  lastCausesAt: number,
): SettlementOutcome {
  const reasons: readonly JsonObject[] =
    lastCauses.length === 0
      ? [
          {
            code: 'DEADLINE',
            subject: 'BR-RUA-032',
            detail: `no quiet window of ${String(GOLDEN_TIMING.stabilization_interval_ms)} ms and quiet recheck by ${instantAt(deadline)}; expected settlement before the observation deadline`,
          },
        ]
      : lastCauses.map((cause) => ({
          code: cause,
          subject: 'BR-RUA-032',
          detail: `the sample at ${instantAt(lastCausesAt)} was not quiet (${cause}); expected a quiet sample before ${instantAt(deadline)}`,
        }));
  return {
    samples: samples.map(sampleFields),
    assessment: { status: 'not_established', reasons, restarts: [...restarts], sample_count: samples.length },
    assessed_ms: deadline + 1000,
    capture_ms: deadline,
    ...dlqCapture(samples),
  };
}

function dlqCapture(samples: readonly Sample[]): { readonly dlq_captured_ms?: number } {
  const first = samples.find((sample) => sample.dlq_captured_message_ids.length > 0);
  return first === undefined ? {} : { dlq_captured_ms: first.observed_at_ms };
}

function sampleAt(context: TrialContext, trial: SimulatedTrial, atMs: number, phase: Sample['phase']): Sample {
  const timeline = trial.timeline;
  const state = timeline.treatmentAt(atMs)?.item['state'];
  const queued = context.caller !== 'probe';
  const dlqArrival = timeline.dlqArrivalMs();
  const inDlq = queued && dlqArrival !== undefined && dlqArrival <= atMs ? [messageIdOf(context)] : [];
  return {
    observed_at_ms: atMs,
    phase,
    processing_terminal:
      trial.probe_invocation === undefined ? timeline.finishedAt(atMs) : trial.probe_invocation.ended_ms <= atMs,
    inner_executions_terminal:
      context.caller === 'durable' ? timeline.innerExecutionsTerminalAt(atMs) : 'not_applicable',
    provider_active_calls: timeline.activeCallsAt(atMs),
    provider_held_barriers: state === 'COMMITTED_WAITING' || state === 'TIMEOUT_SIGNALLED' ? 1 : 0,
    provider_pending_releases: state === 'TIMEOUT_OBSERVED' ? 1 : 0,
    treatment_terminal:
      context.caller !== 'probe' && context.scenario === 'CONTROL'
        ? 'not_applicable'
        : state === 'RESPONSE_RELEASED' || state === 'SAFETY_RELEASED',
    source_queue: queued ? timeline.sourceCountersAt(atMs) : 'not_applicable',
    dlq: queued ? timeline.dlqCountersAt(atMs) : 'not_applicable',
    correlated_dlq_message_ids: inDlq,
    dlq_captured_message_ids: inDlq,
    correlated_event_watermark: eventsAtOrBefore(trial.log.events(), atMs),
    ledger_item_count: timeline.ledgerAt(atMs).length,
  };
}

// Every reason the sample is active, in the vocabulary order of SETTLEMENT_RESTART_CAUSES; the
// first one is the restart cause the observer records.
function causesOf(sample: Sample, previous: Sample | undefined): readonly SettlementRestartCause[] {
  const source = sample.source_queue === 'not_applicable' ? undefined : sample.source_queue;
  const newDlqIds =
    previous !== undefined &&
    sample.correlated_dlq_message_ids.some((id) => !previous.correlated_dlq_message_ids.includes(id));
  const checks: readonly (readonly [SettlementRestartCause, boolean])[] = [
    ['SOURCE_VISIBLE', (source?.visible ?? 0) > 0],
    ['SOURCE_IN_FLIGHT', (source?.in_flight ?? 0) > 0],
    ['SOURCE_DELAYED', (source?.delayed ?? 0) > 0],
    ['NEW_CORRELATED_DLQ_MESSAGE', newDlqIds],
    ['UNCAPTURED_DLQ_MESSAGE', uncapturedDlq(sample)],
    [
      'CORRELATED_JOURNAL_ACTIVITY',
      previous !== undefined && sample.correlated_event_watermark > previous.correlated_event_watermark,
    ],
    ['LEDGER_ACTIVITY', previous !== undefined && sample.ledger_item_count !== previous.ledger_item_count],
    [
      'PROVIDER_ACTIVE',
      sample.provider_active_calls + sample.provider_held_barriers + sample.provider_pending_releases > 0,
    ],
    ['PROCESSING_NOT_TERMINAL', !sample.processing_terminal],
    ['INNER_EXECUTION_ACTIVE', sample.inner_executions_terminal === false],
    ['TREATMENT_NOT_TERMINAL', sample.treatment_terminal === false],
  ];
  return checks.filter(([, active]) => active).map(([cause]) => cause);
}

function uncapturedDlq(sample: Sample): boolean {
  const notCaptured = sample.correlated_dlq_message_ids.some((id) => !sample.dlq_captured_message_ids.includes(id));
  if (sample.dlq === 'not_applicable') {
    return notCaptured;
  }
  const waiting = sample.dlq.visible + sample.dlq.in_flight + sample.dlq.delayed;
  return notCaptured || waiting > sample.dlq_captured_message_ids.length;
}

function sampleFields(sample: Sample): SampleFields {
  return {
    observed_at_ms: sample.observed_at_ms,
    fields: {
      schema_version: 1,
      record_type: 'settlement_sample',
      observed_at: instantAt(sample.observed_at_ms),
      phase: sample.phase,
      publication_stopped: true,
      processing_terminal: sample.processing_terminal,
      inner_executions_terminal: sample.inner_executions_terminal,
      provider_active_calls: sample.provider_active_calls,
      provider_held_barriers: sample.provider_held_barriers,
      provider_pending_releases: sample.provider_pending_releases,
      treatment_terminal: sample.treatment_terminal,
      ledger_snapshot_possible: true,
      source_queue: countersJson(sample.source_queue),
      dlq: countersJson(sample.dlq),
      correlated_dlq_message_ids: [...sample.correlated_dlq_message_ids],
      dlq_captured_message_ids: [...sample.dlq_captured_message_ids],
      correlated_event_watermark: sample.correlated_event_watermark,
      ledger_item_count: sample.ledger_item_count,
    },
  };
}

/**
 * Queue counters (or their marker) as the JSON a sample or observation carries.
 *
 * @example
 * countersJson({ visible: 0, in_flight: 1, delayed: 0 }); // { visible: 0, in_flight: 1, delayed: 0 }
 */
export function countersJson(counters: CounterValues | 'not_applicable'): JsonValue {
  return counters === 'not_applicable'
    ? counters
    : { visible: counters.visible, in_flight: counters.in_flight, delayed: counters.delayed };
}
