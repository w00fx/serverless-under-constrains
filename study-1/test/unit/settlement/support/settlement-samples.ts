// Settlement samples for the settlement suites: a quiet sample at an offset from a fixed
// publication instant, and a series of them at the observer's 30 s cadence. Instants are offsets
// on one fixed timeline, so nothing reads a clock.

import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../../src/record-contract/timestamps.ts';
import type { SettlementSample } from '../../../../src/settlement/settlement-policy.ts';

/** 2026-10-05T12:00:05.000Z: the publication instant every series is measured from. */
export const PUBLISHED_MS = Date.UTC(2026, 9, 5, 12, 0, 5, 0);
export const PUBLISHED_AT = formatUtcMillis(new Date(PUBLISHED_MS));

/**
 * The instant `offsetMs` after publication.
 *
 * @example
 * at(30_000); // '2026-10-05T12:00:35.000Z'
 */
export function at(offsetMs: number): UtcMillis {
  return formatUtcMillis(new Date(PUBLISHED_MS + offsetMs));
}

/**
 * A quiet observation sample `offsetMs` after publication, with `changes` applied.
 *
 * @example
 * quietSample(30_000, { ledger_item_count: 2 });
 */
export function quietSample(offsetMs: number, changes: Partial<SettlementSample> = {}): SettlementSample {
  return {
    observed_at: at(offsetMs),
    phase: 'observation',
    publication_stopped: true,
    processing_terminal: true,
    inner_executions_terminal: 'not_applicable',
    provider_active_calls: 0,
    provider_held_barriers: 0,
    provider_pending_releases: 0,
    treatment_terminal: 'not_applicable',
    ledger_snapshot_possible: true,
    source_queue: { visible: 0, in_flight: 0, delayed: 0 },
    dlq: { visible: 0, in_flight: 0, delayed: 0 },
    correlated_dlq_message_ids: [],
    dlq_captured_message_ids: [],
    correlated_event_watermark: 5,
    ledger_item_count: 1,
    ...changes,
  };
}

/**
 * Quiet observation samples every 30 s from `fromMs` to `toMs` inclusive.
 *
 * @example
 * quietSeries(30_000, 150_000).length; // 5
 */
export function quietSeries(fromMs: number, toMs: number): readonly SettlementSample[] {
  const series: SettlementSample[] = [];
  for (let offset = fromMs; offset <= toMs; offset += 30_000) {
    series.push(quietSample(offset));
  }
  return series;
}

/**
 * A quiet pre-freeze recheck `offsetMs` after publication.
 *
 * @example
 * recheck(155_000).phase; // 'pre_freeze_recheck'
 */
export function recheck(offsetMs: number, changes: Partial<SettlementSample> = {}): SettlementSample {
  return quietSample(offsetMs, { phase: 'pre_freeze_recheck', ...changes });
}
