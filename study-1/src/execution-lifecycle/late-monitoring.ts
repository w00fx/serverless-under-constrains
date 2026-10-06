// P6 late monitoring (design §10.2; BR-RUA-043): after the final trial freeze the consumers stay
// enabled for at least 120 s, so evidence that arrives late is still observed before cleanup cuts
// it off. An interruption during the window shortens it (late evidence `unverified`), and an
// interrupted execution skips it altogether (AC-RUA-049). The window is slept in bounded steps, so
// the gate is consulted at least every poll, and it closes only when both injected clocks show
// 120 s: the monotonic one, so a wall clock stepped forward cannot cut the real window short, and
// the wall one, whose recorded start and end the late-evidence oracle judges.

import type { UtcMillis } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { TrialInterruption } from '../trial-execution/trial-execution-ports.ts';
import type { LateMonitoring } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import { MINIMUM_MONITORING_MS } from '../trial-oracle/late-evidence/monitoring-outcome.ts';
import type { ExecutionServices } from './execution-ports.ts';

const NS_PER_MS = 1_000_000n;

/** How often monitoring checks for an interruption. */
export const MONITORING_POLL_MS = 10_000;

/** What monitoring reads of the gate. */
export interface MonitoringGate {
  interruption(): TrialInterruption | undefined;
}

/**
 * The late-monitoring window of one execution; `skipped` until it runs.
 *
 * @example
 * const monitor = new LateEvidenceMonitor(services);
 * const outcome = await monitor.observe(gate); // { outcome: 'complete', started_at, ended_at }
 */
export class LateEvidenceMonitor {
  readonly #services: ExecutionServices;
  #monitoring: LateMonitoring = { outcome: 'skipped' };

  constructor(services: ExecutionServices) {
    this.#services = services;
  }

  /** How monitoring ended, as the late-evidence assessment declares it. */
  monitoring(): LateMonitoring {
    return this.#monitoring;
  }

  /**
   * Keeps the window open for at least 120 s, or until the gate reports an interruption.
   *
   * @example
   * (await monitor.observe(gate)).outcome; // 'shortened' when SIGINT arrived during the window
   */
  async observe(gate: MonitoringGate): Promise<LateMonitoring> {
    const startedMs = this.#services.clock.now().getTime();
    const startedNs = this.#services.monotonic.nowNs();
    const started = formatUtcMillis(new Date(startedMs));
    for (let elapsed = 0; elapsed < MINIMUM_MONITORING_MS; elapsed = this.#elapsedSince(startedMs, startedNs)) {
      if (gate.interruption() !== undefined) {
        return this.#settle({ outcome: 'shortened', started_at: started, ended_at: this.#now() });
      }
      await this.#services.sleeper.sleep(Math.min(MONITORING_POLL_MS, MINIMUM_MONITORING_MS - elapsed));
    }
    return this.#settle({ outcome: 'complete', started_at: started, ended_at: this.#now() });
  }

  #settle(monitoring: LateMonitoring): LateMonitoring {
    this.#monitoring = monitoring;
    return monitoring;
  }

  // The shorter of the two clocks' readings of the window.
  #elapsedSince(startedMs: number, startedNs: bigint): number {
    const wallMs = this.#services.clock.now().getTime() - startedMs;
    const monotonicMs = Number((this.#services.monotonic.nowNs() - startedNs) / NS_PER_MS);
    return Math.min(wallMs, monotonicMs);
  }

  #now(): UtcMillis {
    return formatUtcMillis(this.#services.clock.now());
  }
}
