// Normal and emergency cleanup (BR-RUA-048, BR-RUA-049, design §10.4; AC-RUA-011).
//
// One run walks the steps in its mode's order. Before each step it folds every action recorded
// so far (earlier runs' history plus this run) and skips a step that already succeeded, except
// the audit and freeze steps 10-12, which always run again. Each step journals a `started`
// action, its item actions, and a terminal action with its reasons.
//
// Cleanup never abandons the remaining steps: a step that fails, or a port that throws, is
// recorded and the next step runs (BR-RUA-046 "exceeding it is a duration breach rather than
// permission to abandon cleanup"). Step 5 always precedes step 9 in both orders, so running
// durable executions are stopped before the stack deletion they would block (RK-10).

import type { JournalWriter } from '../event-journal/journal-writer.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type {
  ExecutionIdentity,
  Sha256Hex,
  StructuredReason,
  UtcMillis,
  WallClock,
} from '../record-contract/primitives.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { CleanupActionEntry } from './cleanup-action-fold.ts';
import { foldCleanupActions } from './cleanup-action-fold.ts';
import type { CleanupHistory } from './cleanup-history.ts';
import { CleanupJournal } from './cleanup-journal.ts';
import type { CleanupSafetyClock, StepReport } from './cleanup-ports.ts';
import { buildCleanupResult } from './cleanup-result.ts';
import type { CleanupTargets, StepContext, StepPorts } from './cleanup-step-dispatch.ts';
import { runCleanupStep } from './cleanup-step-dispatch.ts';
import type { CleanupStepNumber } from './cleanup-steps.ts';
import { cleanupStepOrder, mustRunStep, STEP_ACTIONS } from './cleanup-steps.ts';
import type { AuditInput } from './leak-auditor.ts';
import type { OwnershipContext } from './ownership-context.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { reasonFromThrown } from './thrown-reason.ts';

/** The leak audit as the orchestrator uses it (`LeakAuditor` in production). */
export interface LeakAuditRunner {
  audit(input: AuditInput): Promise<LeakAuditResult>;
}

export interface CleanupPorts extends StepPorts {
  /** The writer of this run's `cleanup` source instance on the cleanup journal. */
  readonly journal: JournalWriter;
  readonly auditor: LeakAuditRunner;
  readonly clock: WallClock;
  readonly safety: CleanupSafetyClock;
}

export interface CleanupInput {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly ownership: OwnershipContext;
  readonly targets: CleanupTargets;
  /** What earlier cleanup runs recorded (`readCleanupHistory`); empty on the first run. */
  readonly history: CleanupHistory;
}

export interface CleanupRunOutcome {
  readonly cleanup_result: CleanupResult;
  readonly leak_audit_result: LeakAuditResult;
  /** What the step-12 freeze reported. */
  readonly freeze: StepOutcome;
}

interface RunState {
  readonly mode: CleanupMode;
  readonly input: CleanupInput;
  readonly journal: CleanupJournal;
  /** Reasons not yet attached to a step: history findings, then journal refusals. */
  readonly carried: StructuredReason[];
  leakAudit: LeakAuditResult;
}

/**
 * Runs cleanup to its frozen results; never throws on a port failure.
 *
 * @example
 * const orchestrator = new CleanupOrchestrator(ports);
 * const outcome = await orchestrator.runNormal({ execution, execution_manifest_sha256, ownership, targets, history });
 * outcome.cleanup_result.cleanup_status; // 'succeeded'
 */
export class CleanupOrchestrator {
  readonly #ports: CleanupPorts;

  constructor(ports: CleanupPorts) {
    this.#ports = ports;
  }

  /** Normal cleanup after an execution ends (BR-RUA-048). */
  async runNormal(input: CleanupInput): Promise<CleanupRunOutcome> {
    return this.#run('NORMAL', input);
  }

  /** Emergency cleanup: consumers stop first and the late-evidence steps shorten (BR-RUA-049). */
  async runEmergency(input: CleanupInput): Promise<CleanupRunOutcome> {
    return this.#run('EMERGENCY', input);
  }

  async #run(mode: CleanupMode, input: CleanupInput): Promise<CleanupRunOutcome> {
    const runStartedAt = this.#now();
    const state: RunState = {
      mode,
      input,
      journal: new CleanupJournal(this.#ports.journal, this.#ports.clock),
      carried: [...input.history.findings],
      leakAudit: notAuditedResult(input, runStartedAt),
    };
    for (const step of cleanupStepOrder(mode)) {
      if (step !== 12 && mustRunStep(step, this.#fold(state).succeeded_steps)) {
        await this.#runStep(step, state);
      }
    }
    return this.#freeze(state, runStartedAt);
  }

  async #runStep(step: Exclude<CleanupStepNumber, 12>, state: RunState): Promise<void> {
    await this.#recordStep(step, 'started', [], state);
    const context: StepContext = {
      mode: state.mode,
      ports: this.#ports,
      targets: state.input.targets,
      ownership: state.input.ownership,
      fold: this.#fold(state),
      audit: async () => {
        state.leakAudit = await this.#auditTotally(state);
        return state.leakAudit;
      },
      latestAudit: () => state.leakAudit,
    };
    const outcome = await stepTotally(step, () => runCleanupStep(step, context, itemRecorder(step, state)));
    await this.#recordStep(step, outcome.status, outcome.reasons, state);
  }

  async #freeze(state: RunState, runStartedAt: UtcMillis): Promise<CleanupRunOutcome> {
    await this.#recordStep(12, 'started', [], state);
    const cleanupResult = buildCleanupResult({
      execution: state.input.execution,
      execution_manifest_sha256: state.input.execution_manifest_sha256,
      cleanup_mode: state.mode,
      fold: this.#fold(state),
      started_at: earliestStart(this.#entries(state), runStartedAt),
      completed_at: this.#now(),
      duration_breach: this.#ports.safety.totalTargetExceeded(),
    });
    const results = { cleanup_result: cleanupResult, leak_audit_result: state.leakAudit };
    const freeze = await stepTotally(12, () => this.#ports.evidence.freezeResults(results));
    await this.#recordStep(12, freeze.status, freeze.reasons, state);
    return { ...results, freeze };
  }

  async #auditTotally(state: RunState): Promise<LeakAuditResult> {
    const { execution, execution_manifest_sha256, ownership } = state.input;
    try {
      return await this.#ports.auditor.audit({ execution, execution_manifest_sha256, ownership });
    } catch (thrown: unknown) {
      state.carried.push(reasonFromThrown(thrown, 'LEAK_AUDIT_THREW', 'leak-audit'));
      return notAuditedResult(state.input, this.#now());
    }
  }

  async #recordStep(
    step: CleanupStepNumber,
    status: StepReport['status'] | 'started',
    reasons: readonly StructuredReason[],
    state: RunState,
  ): Promise<void> {
    const carried = status === 'started' ? [] : state.carried.splice(0);
    await state.journal.record({
      step,
      step_status: status,
      cleanup_mode: state.mode,
      cleanup_induced: false,
      action: STEP_ACTIONS[step],
      reasons: [...reasons, ...carried, ...state.journal.takeFailure()],
    });
  }

  #entries(state: RunState): readonly CleanupActionEntry[] {
    return [...state.input.history.entries, ...state.journal.entries()];
  }

  #fold(state: RunState): ReturnType<typeof foldCleanupActions> {
    return foldCleanupActions(this.#entries(state));
  }

  #now(): UtcMillis {
    return formatUtcMillis(this.#ports.clock.now());
  }
}

function itemRecorder(step: CleanupStepNumber, state: RunState): ItemRecorder {
  return async (item) => {
    await state.journal.record({
      step,
      step_status: 'started',
      cleanup_mode: state.mode,
      cleanup_induced: item.cleanup_induced ?? false,
      action: item.action,
      resource_type: item.resource_type,
      resource_identifier: item.resource_identifier,
      ...(item.ownership_basis === undefined ? {} : { ownership_basis: item.ownership_basis }),
      reasons: item.reasons ?? [],
    });
  };
}

async function stepTotally(step: CleanupStepNumber, run: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    return await run();
  } catch (thrown: unknown) {
    return {
      status: 'failed',
      reasons: [reasonFromThrown(thrown, 'STEP_FAILED_UNEXPECTEDLY', `step ${String(step)}`)],
    };
  }
}

function earliestStart(entries: readonly CleanupActionEntry[], runStartedAt: UtcMillis): UtcMillis {
  return entries.reduce(
    (earliest, entry) => (entry.occurred_at < earliest ? entry.occurred_at : earliest),
    runStartedAt,
  );
}

// The audit result before step 10 runs, or when the audit itself threw: no pass, so `inconclusive`.
function notAuditedResult(input: CleanupInput, auditedAt: UtcMillis): LeakAuditResult {
  return {
    schema_version: 1,
    record_type: 'leak_audit_result',
    ...executionIdentityFields(input.execution),
    execution_manifest_sha256: input.execution_manifest_sha256,
    leak_audit_status: 'inconclusive',
    passes: [],
    leaks: [],
    ambiguous: [],
    stable_absence_interval_ms: 0,
    audited_at: auditedAt,
  };
}
