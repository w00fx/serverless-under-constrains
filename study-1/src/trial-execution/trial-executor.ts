// The trial executor (design §5.3 `TrialExecutor`, §10.2 P4): one declared trial, T1 to T11.
//   execution configuration present (A-09), gate open
//   T1 freeze inputs -> T2 partitions absent -> T3 configuration, payment, registration
//   -> T4 arm (treatment) -> provider warm-up (addendum §2) -> T5 gate -> T6 publish
//   -> T7 observe -> T8 collect -> T9 recheck (activity: back to T7) -> T10 write, evaluate
//   -> T11 index, trial_evidence_frozen
// Everything before T6 is setup: a refusal there starts no trial. From T6 on the trial has
// started and always freezes, settled or not (D-29). An interruption seen while observing or
// collecting, before the pre-freeze recheck, records `trial_interrupted` and freezes what can be
// collected, indeterminate (design §10.2).

import { collectTrialEvidence } from '../evidence-collection/trial-collection.ts';
import type { TrialCollection } from '../evidence-collection/trial-collection.ts';
import type { TrialCaptureScope } from '../evidence-collection/capture-scope.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { TRIAL_SETTLEMENT_POLICY } from '../settlement/settlement-policy.ts';
import { confirmExecutionConfiguration } from './execution-configuration.ts';
import { RunnerUnitJournal } from './runner-trial-journal.ts';
import { warmUpProvider } from './runner-warmup.ts';
import { SettlementObserver } from './settlement-observer.ts';
import type { SettledCapture } from './settlement-observer.ts';
import { readSettlementRound } from './settlement-reading.ts';
import type { SettlementReadingPorts, SettlementReadingTarget } from './settlement-reading.ts';
import { freezeTrialEvidence } from './trial-freeze.ts';
import { freezeTrialInputs } from './trial-inputs.ts';
import type { FrozenTrialInputs, TrialFileTarget } from './trial-inputs.ts';
import { publishTrialMessage } from './trial-publication.ts';
import { armTreatment, describeReasons, gateClosed, verifyPartitionsAbsent, writeControlItems } from './trial-setup.ts';
import type { UnitSetupContext } from './trial-setup.ts';
import type {
  PublicationGate,
  TrialExecutionReport,
  TrialExecutorDeps,
  TrialInterruption,
  TrialPlan,
} from './trial-execution-ports.ts';

/** A started trial's settled (or not) evidence, ready to freeze. */
interface ObservedTrial extends SettledCapture<TrialCollection> {
  readonly failures: readonly StructuredReason[];
}

/** One trial after T1: its frozen inputs, its runner journal and its partition. */
interface StartedTrial {
  readonly plan: TrialPlan;
  readonly gate: PublicationGate;
  readonly frozen: FrozenTrialInputs;
  readonly journal: RunnerUnitJournal;
  readonly scope: TrialCaptureScope;
  readonly target: TrialFileTarget;
}

export class TrialExecutor {
  readonly #deps: TrialExecutorDeps;
  readonly #readings: SettlementReadingPorts;
  readonly #observer: SettlementObserver;

  constructor(deps: TrialExecutorDeps) {
    this.#deps = deps;
    this.#readings = {
      store: deps.store,
      queues: deps.queues,
      dlq: deps.dlq,
      durable: deps.durable,
      clock: deps.clock,
    };
    this.#observer = new SettlementObserver({ clock: deps.clock, sleeper: deps.sleeper });
  }

  /**
   * Runs one declared trial to its frozen evidence, or reports why it never started.
   *
   * @example
   * const report = await executor.execute(plan, gate);
   * if (report.kind === 'frozen') report.evidence_index_path; // 'trials/<trial_id>/evidence-index.json'
   */
  async execute(plan: TrialPlan, gate: PublicationGate): Promise<TrialExecutionReport> {
    const preconditions = await this.#preconditions(plan, gate);
    if (preconditions.length > 0) {
      return this.#notStarted(plan, preconditions);
    }
    const target: TrialFileTarget = {
      files: this.#deps.files,
      package_directory: PACKAGE_LAYOUT.executionDirectory(plan.execution),
    };
    const frozen = await freezeTrialInputs(target, plan, this.#deps.clock);
    if (!frozen.ok) {
      return this.#notStarted(plan, frozen.error);
    }
    const trial = this.#started(plan, gate, frozen.value, target);
    const setup = await this.#setUp(trial);
    if (setup.length > 0) {
      return this.#notStarted(plan, setup);
    }
    const published = await publishTrialMessage({
      publisher: this.#deps.publisher,
      target,
      journal: trial.journal,
      clock: this.#deps.clock,
      validator: this.#deps.validator,
      plan,
      manifest: frozen.value.manifest,
      manifest_sha256: frozen.value.manifest_sha256,
    });
    if (published.kind === 'not_published') {
      return this.#notStarted(plan, published.reasons);
    }
    const observed = await this.#observeAndCollect(trial, published.published_at);
    return this.#freeze(trial, observed, published.failures);
  }

  // A-09 and the gate: nothing is written for a trial that cannot start.
  async #preconditions(plan: TrialPlan, gate: PublicationGate): Promise<readonly StructuredReason[]> {
    const missing = await confirmExecutionConfiguration(this.#deps.store, plan);
    const closed = gateClosed(gate);
    return [...(missing === undefined ? [] : [missing]), ...(closed === undefined ? [] : [closed])];
  }

  #started(plan: TrialPlan, gate: PublicationGate, frozen: FrozenTrialInputs, target: TrialFileTarget): StartedTrial {
    const unit = {
      kind: 'trial',
      trial_id: plan.trial.trial_id,
      trial_manifest_sha256: frozen.manifest_sha256,
    } as const;
    const scope = { execution: plan.execution, execution_manifest_sha256: plan.execution_manifest_sha256, unit };
    return {
      plan,
      gate,
      frozen,
      target,
      scope,
      journal: new RunnerUnitJournal({
        file: this.#deps.runner_journal,
        package_directory: target.package_directory,
        scope,
        clock: this.#deps.clock,
        ids: this.#deps.ids,
      }),
    };
  }

  // T2-T4, the warm-up and the T5 gate, in order; the first refusal stops the setup.
  async #setUp(trial: StartedTrial): Promise<readonly StructuredReason[]> {
    const { plan } = trial;
    const context: UnitSetupContext = {
      store: this.#deps.store,
      journal: trial.journal,
      clock: this.#deps.clock,
      scope: trial.scope,
      configuration: {
        registered_caller_id: plan.trial.variant_id,
        scenario: plan.trial.scenario,
        payment: plan.payment,
        timing: plan.provider_timing,
      },
      registry_variant: plan.trial.variant_id,
    };
    const steps: readonly (() => Promise<readonly StructuredReason[]>)[] = [
      (): Promise<readonly StructuredReason[]> => verifyPartitionsAbsent(context),
      (): Promise<readonly StructuredReason[]> => writeControlItems(context),
      (): Promise<readonly StructuredReason[]> => armTreatment(context),
      async (): Promise<readonly StructuredReason[]> => {
        const failed = await warmUpProvider(this.#deps.warmup, trial.plan, this.#deps.ids, this.#deps.validator);
        return failed === undefined ? [] : [failed];
      },
      (): Promise<readonly StructuredReason[]> => {
        const closed = gateClosed(trial.gate);
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

  // T7-T9: observe until the window completes, collect, recheck; activity sends it back to T7.
  // An interruption that stops it is journaled as `trial_interrupted` (design §10.2).
  async #observeAndCollect(trial: StartedTrial, publishedAt: UtcMillis): Promise<ObservedTrial> {
    const { plan } = trial;
    const durable =
      plan.durable_caller === undefined ? undefined : { ...plan.durable_caller, started_after: publishedAt };
    const target: SettlementReadingTarget = {
      scope: trial.scope,
      scenario: plan.trial.scenario,
      source: plan.queues.source,
      dlq: plan.queues.dlq,
      ...(durable === undefined ? {} : { durable }),
    };
    const settled = await this.#observer.settle(
      {
        read: (phase, previous) => readSettlementRound(this.#readings, target, phase, previous),
        published_at: publishedAt,
        policy: TRIAL_SETTLEMENT_POLICY,
        interruption: () => trial.gate.interruption(),
      },
      () =>
        collectTrialEvidence(this.#deps, {
          scope: trial.scope,
          variant: plan.trial.variant_id,
          dlq: plan.queues.dlq,
          ...(durable === undefined ? {} : { durable }),
        }),
    );
    if (settled.interruption === undefined) {
      return { ...settled, failures: [] };
    }
    return { ...settled, failures: await this.#recordInterruption(trial, settled.interruption) };
  }

  async #recordInterruption(
    trial: StartedTrial,
    interruption: TrialInterruption,
  ): Promise<readonly StructuredReason[]> {
    this.#deps.log({
      level: 'warn',
      event: 'trial_interrupted',
      trial_id: trial.plan.trial.trial_id,
      detail: `${interruption.cause}: ${interruption.detail}`,
    });
    const written = await trial.journal.record('trial_interrupted', interruption);
    return written.ok ? [] : [written.error];
  }

  async #freeze(
    trial: StartedTrial,
    observed: ObservedTrial,
    publicationFailures: readonly StructuredReason[],
  ): Promise<TrialExecutionReport> {
    const trialId = trial.plan.trial.trial_id;
    const frozen = await freezeTrialEvidence(
      {
        target: trial.target,
        journal: trial.journal,
        clock: this.#deps.clock,
        validator: this.#deps.validator,
        execution: trial.plan.execution,
        scope: trial.scope,
        manifest: trial.frozen.manifest,
      },
      observed,
    );
    if (!frozen.ok) {
      this.#deps.log({
        level: 'error',
        event: 'trial_freeze_failed',
        trial_id: trialId,
        detail: describeReasons(frozen.error),
      });
      return { kind: 'freeze_failed', trial_id: trialId, reasons: frozen.error };
    }
    this.#deps.log({
      level: 'info',
      event: 'trial_evidence_frozen',
      trial_id: trialId,
      detail: frozen.value.evidence_index_path,
    });
    return {
      kind: 'frozen',
      trial_id: trialId,
      settlement: observed.assessment,
      ...(observed.interruption === undefined ? {} : { interruption: observed.interruption }),
      evidence_index_path: frozen.value.evidence_index_path,
      evidence_index_sha256: frozen.value.evidence_index_sha256,
      failures: [...publicationFailures, ...observed.failures, ...frozen.value.failures],
    };
  }

  #notStarted(plan: TrialPlan, reasons: readonly StructuredReason[]): TrialExecutionReport {
    const trialId = plan.trial.trial_id;
    this.#deps.log({ level: 'warn', event: 'trial_not_started', trial_id: trialId, detail: describeReasons(reasons) });
    return { kind: 'not_started', trial_id: trialId, reasons };
  }
}
