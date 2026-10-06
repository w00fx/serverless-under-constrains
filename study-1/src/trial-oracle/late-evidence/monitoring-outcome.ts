// How late monitoring effectively ended (BR-RUA-043: "Normal late monitoring continues for at least
// 120 seconds after the final trial freeze ... Emergency cleanup may shorten or skip it and records
// `unverified`"; D-16). A declared complete monitoring is complete only when its window lasted at
// least 120 s and every late record could be read and folded: a shorter window is a shortened
// monitoring, and unreadable late evidence is a failed one. Anything but complete makes the late
// evidence `unverified` and carries the reasons why.

import { err, ok } from '../../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../../record-contract/primitives.ts';
import { isUtcMillis } from '../../record-contract/timestamps.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import type { LateMonitoringOutcome } from '../../record-contract/records/group-c/vocabulary.ts';
import type { LateMonitoring } from './late-evidence-input.ts';
import { LATE_EVIDENCE_SUBJECT, lateProblemReasons } from './late-evidence-reasons.ts';
import type { LateProblem } from './late-evidence-reasons.ts';

/** BR-RUA-043: normal late monitoring lasts at least 120 seconds. */
export const MINIMUM_MONITORING_MS = 120_000;

/** The monitoring window as recorded: a skipped monitoring has none. */
export interface MonitoringWindow {
  readonly started_at?: UtcMillis;
  readonly ended_at?: UtcMillis;
}

export interface EffectiveMonitoring {
  readonly outcome: LateMonitoringOutcome;
  readonly window: MonitoringWindow;
  /** Why monitoring is not complete; empty exactly when it is. */
  readonly reasons: readonly StructuredReason[];
}

const DECLARED_REASONS: Readonly<Record<Exclude<LateMonitoringOutcome, 'complete'>, string>> = {
  shortened: 'MONITORING_SHORTENED',
  skipped: 'MONITORING_SKIPPED',
  failed: 'MONITORING_FAILED',
};

/**
 * The recorded window of a declared monitoring, or why it is not a window: each time must be an
 * existing UTC instant, the end needs the start and cannot precede it.
 *
 * @example
 * monitoringWindow({ outcome: 'complete', started_at: t0, ended_at: t1 }); // ok({ started_at: t0, ended_at: t1 })
 */
export function monitoringWindow(monitoring: LateMonitoring): Result<MonitoringWindow, StructuredReason> {
  if (monitoring.outcome === 'skipped') {
    return ok({});
  }
  const { started_at: started, ended_at: ended } = monitoring;
  // The times are typed, but the input reaches here from outside the trial oracle.
  const times: readonly (string | undefined)[] = [started, ended];
  const malformed = times.find((time) => time !== undefined && !isUtcMillis(time));
  if (malformed !== undefined) {
    return err(windowReason(`monitoring time ${boundedJsonText(malformed)}; expected YYYY-MM-DDTHH:mm:ss.SSSZ`));
  }
  if (ended !== undefined && started === undefined) {
    return err(windowReason(`monitoring ended at ${ended} without a start; expected monitoring_started_at too`));
  }
  if (started !== undefined && ended !== undefined && Date.parse(ended) < Date.parse(started)) {
    return err(windowReason(`monitoring ended at ${ended} before it started at ${started}; expected end >= start`));
  }
  return ok({
    ...(started === undefined ? {} : { started_at: started }),
    ...(ended === undefined ? {} : { ended_at: ended }),
  });
}

/**
 * How monitoring effectively ended, given its declared outcome, its window and the late problems.
 *
 * @example
 * effectiveMonitoring('complete', { started_at: t0, ended_at: t0PlusOneMinute }, []).outcome; // 'shortened'
 */
export function effectiveMonitoring(
  declared: LateMonitoringOutcome,
  window: MonitoringWindow,
  problems: readonly LateProblem[],
): EffectiveMonitoring {
  const problemReasons = lateProblemReasons(problems);
  if (declared !== 'complete') {
    const detail = `late monitoring was declared ${declared}; expected complete monitoring of at least 120 s`;
    return { outcome: declared, window, reasons: [lateReason(DECLARED_REASONS[declared], detail), ...problemReasons] };
  }
  if (problemReasons.length > 0) {
    return { outcome: 'failed', window, reasons: problemReasons };
  }
  const lasted = windowLength(window);
  if (lasted < MINIMUM_MONITORING_MS) {
    const detail = `late monitoring lasted ${String(lasted)} ms; expected at least ${String(MINIMUM_MONITORING_MS)} ms after the final freeze`;
    return { outcome: 'shortened', window, reasons: [lateReason('MONITORING_WINDOW_SHORT', detail)] };
  }
  return { outcome: 'complete', window, reasons: [] };
}

// A complete monitoring without both times has no measurable window: it lasted 0 ms.
function windowLength(window: MonitoringWindow): number {
  const { started_at: started, ended_at: ended } = window;
  return started === undefined || ended === undefined ? 0 : Date.parse(ended) - Date.parse(started);
}

function windowReason(detail: string): StructuredReason {
  return lateReason('MONITORING_WINDOW_INVALID', detail);
}

function lateReason(code: string, detail: string): StructuredReason {
  return { code, subject: LATE_EVIDENCE_SUBJECT, detail };
}
