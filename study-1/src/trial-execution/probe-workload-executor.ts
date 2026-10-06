// The probe workload executor (design §10.2 P4 for the probe, then P5; BR-RUA-027, BR-RUA-044,
// addendum §2.1). The transport probe runs the trial phases in its own partition
// `<execution_id>#probe` (D-06: it has no trial id), through the same setup, warm-up, observer,
// collection and freeze as a trial (trial-setup.ts, runner-warmup.ts, settlement-observer.ts,
// trial-freeze.ts):
//   execution configuration present (A-09), gate open
//   inputs: probe/inputs/payment.json, probe/inputs/approved-decision.json
//   T2 partitions absent -> T3 provider configuration (caller `probe`) and payment, no registry
//   -> T4 arm the treatment -> the single provider warm-up -> T5 gate
//   T6 exactly one synchronous Invoke of the probe caller, never retried -> probe_workload_invoked
//   T7-T9 observe under PROBE_SETTLEMENT_POLICY from the Invoke's return, collect, recheck
//   T10 write the buffer and samples -> settlement_assessed
//   P5 ingest the probe package and build probe/derived/transport-probe-result.json, then the
//      runner writes coordination/coordination-prefix-checkpoint.json (an injected port)
//   T11 probe/evidence-index.json (scope PROBE, indexing the checkpoint) -> trial_evidence_frozen
// Everything before the Invoke is setup: a refusal there, or a definitive Lambda rejection of the
// Invoke, starts no probe. Once the Invoke may have run, the probe always freezes, settled or not
// (D-29). The observation deadline counts from `probe_workload_invoked.occurred_at`, exactly as the
// oracle re-derives probe settlement (transport-qualification/verdict/probe-settlement.ts).

import type { DlqReceiver } from '../evidence-collection/dlq-capture.ts';
import type { DurableExecutionReader } from '../evidence-collection/durable-metadata.ts';
import type { CaptureScope } from '../evidence-collection/capture-scope.ts';
import { collectTrialEvidence } from '../evidence-collection/trial-collection.ts';
import type { TrialCollectionPorts } from '../evidence-collection/trial-collection.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import { ingestEvidence } from '../evidence-ingestion/ingest-evidence.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { err } from '../record-contract/primitives.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { PROBE_SETTLEMENT_POLICY } from '../settlement/settlement-policy.ts';
import { buildProbeResult } from '../transport-qualification/verdict/probe-result.ts';
import { confirmExecutionConfiguration } from './execution-configuration.ts';
import { judgeProbeInvocation } from './probe-invocation.ts';
import { RunnerUnitJournal } from './runner-trial-journal.ts';
import { warmUpProvider } from './runner-warmup.ts';
import { SettlementObserver } from './settlement-observer.ts';
import type { SettledCapture } from './settlement-observer.ts';
import { readProbeSettlementRound } from './settlement-reading.ts';
import type { TrialCollection } from '../evidence-collection/trial-collection.ts';
import { freezeReason, freezeUnitEvidence } from './trial-freeze.ts';
import { writeUnitFile } from './trial-inputs.ts';
import type { TrialFileTarget } from './trial-inputs.ts';
import { armTreatment, describeReasons, gateClosed, verifyPartitionsAbsent, writeControlItems } from './trial-setup.ts';
import type { UnitSetupContext } from './trial-setup.ts';
import type {
  ProbeExecutionReport,
  ProbeWorkloadExecutorDeps,
  ProbeWorkloadPlan,
  PublicationGate,
  TrialInterruption,
} from './trial-execution-ports.ts';

/** The probe after its inputs: its gate, its runner journal, its partition and its package. */
interface StartedProbe {
  readonly plan: ProbeWorkloadPlan;
  readonly gate: PublicationGate;
  readonly journal: RunnerUnitJournal;
  readonly scope: CaptureScope;
  readonly target: TrialFileTarget;
}

/** The started probe's Invoke: when observation starts and whether the Invoke returned. */
interface InvokedProbe {
  readonly published_at: UtcMillis;
  readonly invocation_returned: boolean;
  readonly failures: readonly StructuredReason[];
}

const PROBE_UNIT = { kind: 'probe' } as const;

// The probe has no queue and no Durable caller (design §7: `probe/` has no `queues/`), so its
// collection plan names neither and the collector never reads through these. Were it to, the
// read would fail closed with a reason instead of reading another unit's resources.
const NO_PROBE_QUEUE = { code: 'PROBE_HAS_NO_QUEUE' } as const;
const NO_PROBE_DURABLE = { code: 'PROBE_HAS_NO_DURABLE_CALLER' } as const;

/** The DLQ and Durable readers of the probe's collection: none exist, every read fails closed. */
export const PROBE_COLLECTION_READERS: { readonly dlq: DlqReceiver; readonly durable: DurableExecutionReader } = {
  dlq: { receiveBatch: () => Promise.resolve(err(NO_PROBE_QUEUE)) },
  durable: {
    listPage: () => Promise.resolve(err(NO_PROBE_DURABLE)),
    getExecution: () => Promise.resolve(err(NO_PROBE_DURABLE)),
    historyPage: () => Promise.resolve(err(NO_PROBE_DURABLE)),
  },
};

export class ProbeWorkloadExecutor {
  readonly #deps: ProbeWorkloadExecutorDeps;
  readonly #observer: SettlementObserver;
  readonly #collection: TrialCollectionPorts;

  constructor(deps: ProbeWorkloadExecutorDeps) {
    this.#deps = deps;
    this.#observer = new SettlementObserver({ clock: deps.clock, sleeper: deps.sleeper });
    this.#collection = { store: deps.store, telemetry: deps.telemetry, clock: deps.clock, ...PROBE_COLLECTION_READERS };
  }

  /**
   * Runs the probe workload to its frozen evidence and transport probe result, or reports why the
   * probe never started.
   *
   * @example
   * const report = await executor.execute(plan, gate);
   * if (report.kind === 'frozen') report.evidence_index_path; // 'probe/evidence-index.json'
   */
  async execute(plan: ProbeWorkloadPlan, gate: PublicationGate): Promise<ProbeExecutionReport> {
    const preconditions = await this.#preconditions(plan, gate);
    if (preconditions.length > 0) {
      return this.#notStarted(plan, preconditions);
    }
    const probe = this.#started(plan, gate);
    const inputs = await writeProbeInputs(probe);
    if (inputs.length > 0) {
      return this.#notStarted(plan, inputs);
    }
    const setup = await this.#setUp(probe);
    if (setup.length > 0) {
      return this.#notStarted(plan, setup);
    }
    const invoked = await this.#invoke(probe);
    if (invoked.kind === 'not_started') {
      return this.#notStarted(plan, [invoked.reason]);
    }
    const settled = await this.#observeAndCollect(probe, invoked);
    return this.#freeze(probe, settled, [...invoked.failures, ...settled.failures]);
  }

  // A-09 and the gate: nothing is written for a probe that cannot start.
  async #preconditions(plan: ProbeWorkloadPlan, gate: PublicationGate): Promise<readonly StructuredReason[]> {
    const missing = await confirmExecutionConfiguration(this.#deps.store, plan);
    const closed = gateClosed(gate);
    return [...(missing === undefined ? [] : [missing]), ...(closed === undefined ? [] : [closed])];
  }

  #started(plan: ProbeWorkloadPlan, gate: PublicationGate): StartedProbe {
    const scope: CaptureScope = {
      execution: plan.execution,
      execution_manifest_sha256: plan.execution_manifest_sha256,
      unit: PROBE_UNIT,
    };
    const target = { files: this.#deps.files, package_directory: PACKAGE_LAYOUT.executionDirectory(plan.execution) };
    const journal = new RunnerUnitJournal({
      file: this.#deps.runner_journal,
      package_directory: target.package_directory,
      scope,
      clock: this.#deps.clock,
      ids: this.#deps.ids,
    });
    return { plan, gate, journal, scope, target };
  }

  // T2-T4, the single warm-up (addendum §2.1) and the T5 gate, in order; the first refusal stops.
  async #setUp(probe: StartedProbe): Promise<readonly StructuredReason[]> {
    const { plan } = probe;
    const context: UnitSetupContext = {
      store: this.#deps.store,
      journal: probe.journal,
      clock: this.#deps.clock,
      scope: probe.scope,
      configuration: {
        registered_caller_id: 'probe',
        scenario: 'COMMIT_THEN_TIMEOUT',
        payment: plan.payment,
        timing: plan.provider_timing,
      },
    };
    const steps: readonly (() => Promise<readonly StructuredReason[]>)[] = [
      (): Promise<readonly StructuredReason[]> => verifyPartitionsAbsent(context),
      (): Promise<readonly StructuredReason[]> => writeControlItems(context),
      (): Promise<readonly StructuredReason[]> => armTreatment(context),
      async (): Promise<readonly StructuredReason[]> => {
        const failed = await warmUpProvider(this.#deps.warmup, plan, this.#deps.ids, this.#deps.validator);
        return failed === undefined ? [] : [failed];
      },
      (): Promise<readonly StructuredReason[]> => {
        const closed = gateClosed(probe.gate);
        return Promise.resolve(closed === undefined ? [] : [closed]);
      },
    ];
    for (const step of steps) {
      const reasons = await step();
      if (reasons.length > 0) {
        return reasons;
      }
    }
    return [];
  }

  // T6: exactly one Invoke, no retry. A recordable response is journaled, and observation starts
  // at the event's own `occurred_at`; otherwise it starts now.
  async #invoke(
    probe: StartedProbe,
  ): Promise<
    { readonly kind: 'not_started'; readonly reason: StructuredReason } | (InvokedProbe & { kind: 'started' })
  > {
    const judged = judgeProbeInvocation(await this.#deps.workload.invokeWorkload(probe.plan.request), probe.plan);
    if (judged.kind === 'not_started') {
      return judged;
    }
    const now = (): UtcMillis => formatUtcMillis(this.#deps.clock.now());
    const started = { kind: 'started', invocation_returned: judged.invocation_returned } as const;
    if (judged.invoked === undefined) {
      return { ...started, published_at: now(), failures: judged.failures };
    }
    const written = await probe.journal.record('probe_workload_invoked', judged.invoked);
    return written.ok
      ? { ...started, published_at: written.value.occurred_at, failures: judged.failures }
      : { ...started, published_at: now(), failures: [...judged.failures, written.error] };
  }

  // T7-T9 under the probe policy; an interruption that stops it is journaled (design §10.2).
  async #observeAndCollect(
    probe: StartedProbe,
    invoked: InvokedProbe,
  ): Promise<SettledCapture<TrialCollection> & { readonly failures: readonly StructuredReason[] }> {
    const readings = { store: this.#deps.store, clock: this.#deps.clock };
    const settled = await this.#observer.settle(
      {
        read: (phase, previous) =>
          readProbeSettlementRound(readings, probe.scope, invoked.invocation_returned, phase, previous),
        published_at: invoked.published_at,
        policy: PROBE_SETTLEMENT_POLICY,
        interruption: () => probe.gate.interruption(),
      },
      () => collectTrialEvidence(this.#collection, { scope: probe.scope }),
    );
    if (settled.interruption === undefined) {
      return { ...settled, failures: [] };
    }
    return { ...settled, failures: await this.#recordInterruption(probe, settled.interruption) };
  }

  async #recordInterruption(
    probe: StartedProbe,
    interruption: TrialInterruption,
  ): Promise<readonly StructuredReason[]> {
    this.#log(probe.plan, 'warn', 'probe_interrupted', `${interruption.cause}: ${interruption.detail}`);
    const written = await probe.journal.record('trial_interrupted', interruption);
    return written.ok ? [] : [written.error];
  }

  // T10, P5 and T11: the buffer and samples, the probe result, the checkpoint, the index.
  async #freeze(
    probe: StartedProbe,
    settled: SettledCapture<TrialCollection>,
    earlier: readonly StructuredReason[],
  ): Promise<ProbeExecutionReport> {
    const probeId = probe.plan.execution.transport_probe_id;
    const frozen = await freezeUnitEvidence(
      {
        target: probe.target,
        journal: probe.journal,
        clock: this.#deps.clock,
        execution: probe.plan.execution,
        scope: probe.scope,
        index: { index_scope: 'PROBE', transport_probe_id: probeId },
      },
      settled,
      () => this.#deriveTransportResult(probe),
    );
    if (!frozen.ok) {
      this.#log(probe.plan, 'error', 'probe_freeze_failed', describeReasons(frozen.error));
      return { kind: 'freeze_failed', transport_probe_id: probeId, reasons: frozen.error };
    }
    this.#log(probe.plan, 'info', 'probe_evidence_frozen', frozen.value.evidence_index_path);
    return {
      kind: 'frozen',
      transport_probe_id: probeId,
      settlement: settled.assessment,
      ...(settled.interruption === undefined ? {} : { interruption: settled.interruption }),
      evidence_index_path: frozen.value.evidence_index_path,
      evidence_index_sha256: frozen.value.evidence_index_sha256,
      failures: [...earlier, ...frozen.value.failures],
    };
  }

  // P5: ingest the probe package as the golden probe input does (every file an artifact, no
  // execution scope) and write the transport probe result; then the runner's prefix checkpoint,
  // which the probe evidence index must hash (BR-RUA-044). A missing checkpoint fails the index.
  async #deriveTransportResult(probe: StartedProbe): Promise<readonly StructuredReason[]> {
    const failures: StructuredReason[] = [];
    const snapshot = await readPackageSnapshot(this.#deps.files, probe.plan.execution);
    if (snapshot.ok) {
      const evidence = ingestEvidence(
        {
          artifacts: snapshot.value.files,
          expected: expectedArtifactsFor(probe.plan.request),
          execution_scope_artifacts: [],
        },
        this.#deps.validator,
      );
      const result = buildProbeResult({ evidence, checked_at: formatUtcMillis(this.#deps.clock.now()) });
      const unwritten = result.ok
        ? await writeUnitFile(probe.target, PROBE_UNIT, 'transportProbeResult', serializeRecordFile(result.value))
        : undefined;
      failures.push(...(result.ok ? [] : result.error), ...(unwritten === undefined ? [] : [unwritten]));
    } else {
      failures.push(freezeReason('PACKAGE_UNREADABLE', `${snapshot.error.code}: ${snapshot.error.detail}`));
    }
    const checkpoint = await this.#deps.checkpoint.writeCheckpoint();
    return checkpoint === undefined ? failures : [...failures, checkpoint];
  }

  #notStarted(plan: ProbeWorkloadPlan, reasons: readonly StructuredReason[]): ProbeExecutionReport {
    this.#log(plan, 'warn', 'probe_not_started', describeReasons(reasons));
    return { kind: 'not_started', transport_probe_id: plan.execution.transport_probe_id, reasons };
  }

  #log(plan: ProbeWorkloadPlan, level: 'info' | 'warn' | 'error', event: string, detail: string): void {
    this.#deps.log({ level, event, transport_probe_id: plan.execution.transport_probe_id, detail });
  }
}

// The probe's inputs (design §7: `probe/inputs/`), written once before any setup; the probe has no
// manifest of its own, so the files are pinned by the probe evidence index.
async function writeProbeInputs(probe: StartedProbe): Promise<readonly StructuredReason[]> {
  const reasons: StructuredReason[] = [];
  for (const [file, record] of [
    ['payment', probe.plan.payment],
    ['approvedDecision', probe.plan.approved_decision],
  ] as const) {
    const unwritten = await writeUnitFile(probe.target, PROBE_UNIT, file, serializeRecordFile(record));
    if (unwritten !== undefined) {
      reasons.push(unwritten);
    }
  }
  return reasons;
}
