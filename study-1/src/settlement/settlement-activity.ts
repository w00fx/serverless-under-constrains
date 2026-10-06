// Which BR-RUA-032 conditions one settlement sample violates (design §8.12): `quiet(s)` and
// `activity(s, prev)` as the restart causes they produce, in the vocabulary order of
// SETTLEMENT_RESTART_CAUSES so the first one is the cause a restart records. The cause vocabulary
// is closed (WP-02), so the two sample flags it has no name for map to the nearest cause: a
// publication that has not stopped means processing is not terminal, and a ledger that cannot be
// snapshotted is ledger activity (evidence/WP-14/decisions.md).

import { SETTLEMENT_RESTART_CAUSES } from '../record-contract/records/group-b/vocabulary.ts';
import type { QueueCounterMarker } from '../record-contract/records/group-b/vocabulary.ts';
import type { QueueCounters, SettlementRestartCause, SettlementSample } from './settlement-policy.ts';

type Counters = QueueCounters | QueueCounterMarker;

/**
 * Every cause that makes `sample` active, in vocabulary order; empty when it is quiet and nothing
 * changed since `previous`. The first sample has no previous one, so only `quiet` applies to it.
 *
 * @example
 * activityCauses(quietSample, undefined); // []
 * activityCauses({ ...quietSample, ledger_item_count: 2 }, quietSample); // ['LEDGER_ACTIVITY']
 */
export function activityCauses(
  sample: SettlementSample,
  previous: SettlementSample | undefined,
): readonly SettlementRestartCause[] {
  const active = new Set<SettlementRestartCause>([...quietViolations(sample), ...changesSince(sample, previous)]);
  return SETTLEMENT_RESTART_CAUSES.filter((cause) => active.has(cause));
}

/**
 * The causes that make `sample` not quiet by itself (§8.12 `quiet(s)`); empty when it is quiet.
 *
 * @example
 * quietViolations({ ...quietSample, source_queue: 'unavailable' }); // ['QUEUE_UNAVAILABLE']
 */
export function quietViolations(sample: SettlementSample): readonly SettlementRestartCause[] {
  return [
    ...sourceQueueCauses(sample.source_queue),
    ...(hasUncapturedDlqMessage(sample) ? (['UNCAPTURED_DLQ_MESSAGE'] as const) : []),
    ...(sample.ledger_snapshot_possible ? [] : (['LEDGER_ACTIVITY'] as const)),
    ...(providerIdle(sample) ? [] : (['PROVIDER_ACTIVE'] as const)),
    ...(sample.processing_terminal && sample.publication_stopped ? [] : (['PROCESSING_NOT_TERMINAL'] as const)),
    ...(sample.inner_executions_terminal === false ? (['INNER_EXECUTION_ACTIVE'] as const) : []),
    ...(sample.treatment_terminal === false ? (['TREATMENT_NOT_TERMINAL'] as const) : []),
    ...(sample.source_queue === 'unavailable' || sample.dlq === 'unavailable' ? (['QUEUE_UNAVAILABLE'] as const) : []),
  ];
}

// §8.12 `activity` beyond `¬quiet`: the journal watermark rose, the ledger count changed, or a
// correlated DLQ message appeared.
function changesSince(
  sample: SettlementSample,
  previous: SettlementSample | undefined,
): readonly SettlementRestartCause[] {
  if (previous === undefined) {
    return [];
  }
  const known = new Set(previous.correlated_dlq_message_ids);
  return [
    ...(sample.correlated_dlq_message_ids.some((id) => !known.has(id))
      ? (['NEW_CORRELATED_DLQ_MESSAGE'] as const)
      : []),
    ...(sample.correlated_event_watermark > previous.correlated_event_watermark
      ? (['CORRELATED_JOURNAL_ACTIVITY'] as const)
      : []),
    ...(sample.ledger_item_count === previous.ledger_item_count ? [] : (['LEDGER_ACTIVITY'] as const)),
  ];
}

function sourceQueueCauses(counters: Counters): readonly SettlementRestartCause[] {
  if (typeof counters === 'string') {
    return [];
  }
  return [
    ...(counters.visible > 0 ? (['SOURCE_VISIBLE'] as const) : []),
    ...(counters.in_flight > 0 ? (['SOURCE_IN_FLIGHT'] as const) : []),
    ...(counters.delayed > 0 ? (['SOURCE_DELAYED'] as const) : []),
  ];
}

// A correlated message the observer has not captured, or more messages waiting in the DLQ than it
// captured, is a message settlement has not accounted for.
function hasUncapturedDlqMessage(sample: SettlementSample): boolean {
  const captured = new Set(sample.dlq_captured_message_ids);
  if (sample.correlated_dlq_message_ids.some((id) => !captured.has(id))) {
    return true;
  }
  const dlq = sample.dlq;
  if (typeof dlq === 'string') {
    return false;
  }
  return dlq.visible + dlq.in_flight + dlq.delayed > captured.size;
}

function providerIdle(sample: SettlementSample): boolean {
  return (
    sample.provider_active_calls === 0 && sample.provider_held_barriers === 0 && sample.provider_pending_releases === 0
  );
}
