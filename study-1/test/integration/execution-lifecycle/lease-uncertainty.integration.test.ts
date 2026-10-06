// BR-RUA-045 between trials: a heartbeat failure makes the lease uncertain, which blocks new
// publication without ending the execution. The runner holds the next trial until the heartbeat
// confirms the lease again (every declared trial then runs) or loses it at the stale boundary (the
// execution is interrupted with `LEASE_LOST` and the next trial is never handed over). The real
// `SessionExecutionLease` over `FakeLeaseStore` produces the uncertainty on the world's clock.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TrialRunner } from '../../../src/execution-lifecycle/execution-ports.ts';
import { SessionExecutionLease } from '../../../src/execution-lifecycle/session-lease.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type {
  PublicationGate,
  TrialExecutionReport,
  TrialPlan,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import type { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { RunnerWorld } from './support/runner-world.ts';

/** Enough failed heartbeats to reach the 300 s stale boundary, whatever their cadence. */
const UNTIL_STALE = 1_000;

/** One trial as the runner handed it over. */
interface HandOver {
  readonly trial_id: string;
  readonly at_ms: number;
  readonly publication_allowed: boolean;
}

/**
 * The offline cloud's trials, with the lease store failing `failures` heartbeats once the first
 * trial froze: its report returns only when the lease has become uncertain, so the runner meets
 * the uncertainty exactly where it decides whether to hand over the next trial.
 */
class HeartbeatFaultAfterFirstTrial implements TrialRunner {
  readonly handed: HandOver[] = [];
  uncertainAtMs: number | undefined;
  readonly #inner: TrialRunner;
  readonly #store: FakeLeaseStore;
  readonly #lease: SessionExecutionLease;
  readonly #time: VirtualTimeScheduler;
  readonly #failures: number;

  constructor(
    inner: TrialRunner,
    store: FakeLeaseStore,
    lease: SessionExecutionLease,
    time: VirtualTimeScheduler,
    failures: number,
  ) {
    this.#inner = inner;
    this.#store = store;
    this.#lease = lease;
    this.#time = time;
    this.#failures = failures;
  }

  async execute(plan: TrialPlan, gate: PublicationGate): Promise<TrialExecutionReport> {
    this.handed.push({
      trial_id: plan.trial.trial_id,
      at_ms: this.#time.now().getTime(),
      publication_allowed: gate.publicationAllowed(),
    });
    const report = await this.#inner.execute(plan, gate);
    if (this.handed.length === 1) {
      this.#store.failNextWrites(this.#failures, { kind: 'definitive_failure', code: 'ThrottlingException' });
      while (this.#lease.publicationAllowed()) {
        await this.#time.sleep(1_000);
      }
      this.uncertainAtMs = this.#time.now().getTime();
    }
    return report;
  }
}

interface UncertainWorld {
  readonly world: RunnerWorld;
  readonly trials: HeartbeatFaultAfterFirstTrial;
}

async function uncertainWorld(failures: number): Promise<UncertainWorld> {
  let trials: HeartbeatFaultAfterFirstTrial | undefined;
  const world = await RunnerWorld.create({
    deps: (built) => {
      const store = new FakeLeaseStore({ clock: built.cloud.time });
      const lease = new SessionExecutionLease(built.admitted, {
        store,
        journals: built.cloud.storage,
        scheduler: built.cloud.time,
        services: built.services,
      });
      trials = new HeartbeatFaultAfterFirstTrial(built.cloud.executor, store, lease, built.cloud.time, failures);
      return { lease, trials };
    },
  });
  assert.ok(trials !== undefined);
  return { world, trials };
}

function leaseEvents(world: RunnerWorld): readonly JsonObject[] {
  return world.journal(EXECUTION_PATHS.coordinationJournal);
}

function firstLeaseEventMs(world: RunnerWorld, event: string): number {
  const found = leaseEvents(world).find((record) => record['lease_event'] === event);
  assert.ok(found !== undefined, `the coordination journal records ${event}`);
  return Date.parse(String(found['occurred_at']));
}

describe('BR-RUA-045 lease uncertainty between trials', () => {
  it('holds the next trial until the heartbeat recovers, then runs every declared trial', async () => {
    const { world, trials } = await uncertainWorld(1);
    const outcome = await world.run();

    const declared = world.admitted.manifest.trials.map((trial) => trial.trial_id);
    assert.deepEqual(
      trials.handed.map((handOver) => handOver.trial_id),
      declared,
      'the uncertainty consumed no trial',
    );
    assert.deepEqual(
      trials.handed.map((handOver) => handOver.publication_allowed),
      [true, true, true, true],
      'no trial is handed over while publication is blocked',
    );
    const recoveredMs = firstLeaseEventMs(world, 'RECOVERED');
    assert.ok(firstLeaseEventMs(world, 'HEARTBEAT_FAILED') <= (trials.uncertainAtMs ?? 0));
    assert.ok((trials.handed[1]?.at_ms ?? 0) >= recoveredMs, 'the second trial waits for the recovery');
    assert.ok(recoveredMs > (trials.uncertainAtMs ?? Infinity), 'the runner waited through the uncertainty');

    assert.equal(outcome.interruption, undefined);
    assert.deepEqual(
      outcome.trials.map((report) => report.kind),
      ['frozen', 'frozen', 'frozen', 'frozen'],
    );
    assert.ok(world.runnerEvents().includes('TRIALS:succeeded'));
    assert.ok(world.runnerEvents().includes('LATE_MONITORING:succeeded'));
    assert.equal(outcome.lease_status, 'released');
    assert.equal(world.record(EXECUTION_PATHS.runSummary)['run_terminal_reason'], 'COMPLETED');
  });

  it('hands over no further trial when the uncertainty ends in staleness', async () => {
    const { world, trials } = await uncertainWorld(UNTIL_STALE);
    const outcome = await world.run();

    const [first, second] = world.admitted.manifest.trials.map((trial) => trial.trial_id);
    assert.deepEqual(
      trials.handed.map((handOver) => handOver.trial_id),
      [first],
      'no trial starts once the lease is uncertain',
    );
    assert.equal(world.file(`trials/${second ?? ''}/trial-manifest.json`), undefined);
    assert.ok(leaseEvents(world).some((record) => record['lease_event'] === 'LOST_STALE'));
    assert.equal(outcome.interruption?.cause, 'LEASE_LOST');
    assert.deepEqual(
      outcome.trials.map((report) => report.kind),
      ['frozen'],
    );
    assert.ok(world.runnerEvents().includes('TRIALS:failed'));
    assert.ok(world.runnerEvents().includes('LATE_MONITORING:skipped'));
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
    assert.equal(world.record(EXECUTION_PATHS.runSummary)['run_terminal_reason'], 'LEASE_LOST');
  });
});
