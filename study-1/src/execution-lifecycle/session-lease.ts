// The runner's coordination lease (design §10.2 P1, P8, §10.3; BR-RUA-045): one `LeaseSession` of
// the execution's owner, bound to the frozen manifest digest, journaling every transition into the
// package's coordination journal, and the heartbeat loop that runs beside P2 to P8 and hands a loss
// to the runner once.

import type { LeaseClosure } from '../coordination-lease/lease-finalization.ts';
import { LeaseHeartbeatLoop } from '../coordination-lease/lease-heartbeat-loop.ts';
import type { LeaseLoss } from '../coordination-lease/lease-session.ts';
import { LeaseSession } from '../coordination-lease/lease-session.ts';
import type { LeaseStorePort } from '../coordination-lease/lease-store-port.ts';
import { leaseOwnerOf } from '../coordination-lease/lease-store-port.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { StructuredReason, TimerScheduler } from '../record-contract/primitives.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import { RUNNER_DEFINITIVE_RETRIES } from '../trial-execution/runner-trial-journal.ts';
import type { AdmittedExecution, ExecutionLease, ExecutionServices } from './execution-ports.ts';

/** What the lease of one execution needs. */
export interface SessionLeaseDeps {
  readonly store: LeaseStorePort;
  readonly journals: AppendOnlyFile;
  readonly scheduler: TimerScheduler;
  readonly services: ExecutionServices;
}

/**
 * The coordination lease of one admitted execution.
 *
 * @example
 * const lease = new SessionExecutionLease(admitted, { store, journals, scheduler, services });
 * if ((await lease.acquire()).acquired) lease.startHeartbeats((loss) => gate.interrupt(loss));
 */
export class SessionExecutionLease implements ExecutionLease {
  readonly #admitted: AdmittedExecution;
  readonly #session: LeaseSession;
  readonly #scheduler: TimerScheduler;
  #loop: LeaseHeartbeatLoop | undefined;

  constructor(admitted: AdmittedExecution, deps: SessionLeaseDeps) {
    const { services } = deps;
    this.#admitted = admitted;
    this.#scheduler = deps.scheduler;
    this.#session = new LeaseSession({
      store: deps.store,
      monotonic: services.monotonic,
      wall: services.clock,
      journal: new JournalWriter({
        port: createJsonlJournalPort(
          `${admitted.package_directory}/${EXECUTION_PATHS.coordinationJournal}`,
          deps.journals,
        ),
        source: 'coordination_lease',
        instanceId: services.ids.next(),
        scope: {
          execution: admitted.identity,
          execution_manifest_sha256: admitted.manifest_sha256,
          partition: { kind: 'execution' },
        },
        clock: services.clock,
        ids: services.ids,
        maxDefinitiveRetries: RUNNER_DEFINITIVE_RETRIES,
      }),
      heartbeatIntervalMs: 30_000,
      staleBoundaryMs: 300_000,
    });
  }

  async acquire(): Promise<
    { readonly acquired: true } | { readonly acquired: false; readonly reason: StructuredReason }
  > {
    const acquisition = await this.#session.acquire(
      leaseOwnerOf(this.#admitted.identity, this.#admitted.manifest_sha256),
    );
    return acquisition.acquired ? { acquired: true } : { acquired: false, reason: acquisition.reason };
  }

  publicationAllowed(): boolean {
    return this.#session.publicationAllowed();
  }

  startHeartbeats(onLoss: (loss: LeaseLoss) => void): void {
    this.#loop = new LeaseHeartbeatLoop({
      session: this.#session,
      scheduler: this.#scheduler,
      listener: { leaseLost: onLoss },
    });
    this.#loop.start();
  }

  stopHeartbeats(): void {
    this.#loop?.stop();
  }

  finalize(closure: LeaseClosure): Promise<LeaseStatus> {
    return this.#session.finalize(closure);
  }
}
