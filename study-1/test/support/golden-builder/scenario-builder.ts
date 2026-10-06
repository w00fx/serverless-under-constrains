// Builds a golden base scenario: the primary evidence of an execution prefix as it stands when its
// subject trial is frozen (design §12.4). Earlier trials follow the Expected Configured Trace; the
// subject trial follows the case's plan. The runner journal is one source instance across the
// execution, so its sequence stays dense from the first phase transition to the subject trial's
// `settlement_assessed`.

import type { JsonObject, Result } from '../../../src/record-contract/primitives.ts';
import { TRIAL_PARTITION_TABLE_ROLES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { FixtureFileContent, ScenarioFiles } from './digest-links.ts';
import { linkMd5, linkSha256 } from './digest-links.ts';
import {
  executionContextOf,
  executionManifest,
  resourceManifest,
  trialIdOf,
  EXECUTION_OFFSETS,
} from './execution-files.ts';
import { GoldenEventLog, sortedJournal } from './golden-event-log.ts';
import type { GoldenSourceInstance } from './golden-event-log.ts';
import type { BaseScenarioId, DeclaredTrialShape, GoldenExecution, TrialPlan } from './golden-plan.ts';
import { BASE_SCENARIOS, declaredTrialsOf, defaultTrialPlan } from './golden-plan.ts';
import { GOLDEN_PROVIDER_VERSION } from './golden-values.ts';
import { checkTrialPlan } from './plan-checks.ts';
import { observeSettlement } from './settlement-simulation.ts';
import type { SettlementOutcome } from './settlement-simulation.ts';
import { sequenceNumberOf, trialFiles } from './trial-files.ts';
import { messageIdOf, simulateTrial } from './trial-simulation.ts';
import type { SimulatedTrial } from './trial-simulation.ts';
import {
  EXECUTION_MANIFEST_PATH,
  RESOURCE_MANIFEST_PATH,
  RUNNER_JOURNAL_PATH,
  SLOT_OFFSETS,
  publishedMs,
  slotStartMs,
  trialPath,
} from './trial-context.ts';
import type { ExecutionContext, TrialContext } from './trial-context.ts';

/** A built base: its files and the directory of its subject trial (`probe` for the probe). */
export interface BuiltScenario {
  readonly files: ScenarioFiles;
  readonly subject_directory: string;
}

/**
 * Builds a base scenario, with `subjectPlan` (or the Expected Configured Trace) for its subject
 * trial. Fails with every plan problem when the plan cannot be built.
 *
 * @example
 * const built = buildBaseScenario('run-durable-treatment');
 * if (built.ok) built.value.files.get('runner/runner-journal.jsonl');
 */
export function buildBaseScenario(
  base: BaseScenarioId,
  subjectPlan?: TrialPlan,
): Result<BuiltScenario, readonly string[]> {
  const shape = BASE_SCENARIOS[base];
  const execution = executionContextOf(shape.execution);
  const subject = subjectContext(shape.execution, execution, shape.sequence);
  const plan = subjectPlan ?? defaultTrialPlan(subject.caller, subject.scenario);
  const problems = checkTrialPlan(subject.caller, subject.scenario, plan);
  if (problems.length > 0) {
    return { ok: false, error: problems };
  }
  const files = new Map<string, FixtureFileContent>([
    [EXECUTION_MANIFEST_PATH, { kind: 'json', record: executionManifest(shape.execution) }],
    [RESOURCE_MANIFEST_PATH, { kind: 'json', record: resourceManifest(shape.execution) }],
  ]);
  const runnerLog = new GoldenEventLog({
    label: `${shape.execution}/runner`,
    identity: execution.identity,
    execution_manifest_sha256: linkSha256(EXECUTION_MANIFEST_PATH),
  });
  const runner = runnerLog.instance('runner', 'runner');
  recordPhases(runner);
  const trials = shape.execution === 'probe' ? [] : declaredTrialsOf(shape.execution).slice(0, shape.sequence);
  const contexts =
    shape.execution === 'probe' ? [subject] : trials.map((trial) => trialContext(shape.execution, execution, trial));
  for (const [index, context] of contexts.entries()) {
    const trialPlan = context === contexts.at(-1) ? plan : defaultTrialPlan(context.caller, context.scenario);
    const simulated = simulateTrial(context, trialPlan);
    const settlement = observeSettlement(context, simulated);
    recordTrialRunnerEvents(runner, context, simulated, settlement);
    const registryVersion = contexts.slice(0, index + 1).filter((other) => other.caller === context.caller).length;
    const directory = trialFiles({
      context,
      trial: simulated,
      settlement,
      sequence: index + 1,
      registry_version: registryVersion,
    });
    for (const [path, content] of directory) {
      files.set(path, content);
    }
  }
  files.set(RUNNER_JOURNAL_PATH, { kind: 'jsonl', records: sortedJournal(runnerLog.events()) });
  return { ok: true, value: { files, subject_directory: subject.directory } };
}

/**
 * The directory of a base's subject trial: `trials/<trial_id>`, or `probe`.
 *
 * @example
 * subjectDirectoryOf('probe'); // 'probe'
 */
export function subjectDirectoryOf(base: BaseScenarioId): string {
  const shape = BASE_SCENARIOS[base];
  return subjectContext(shape.execution, executionContextOf(shape.execution), shape.sequence).directory;
}

function subjectContext(executionName: GoldenExecution, execution: ExecutionContext, sequence: number): TrialContext {
  if (executionName === 'probe') {
    return {
      execution,
      label: 'probe/workload',
      caller: 'probe',
      scenario: 'COMMIT_THEN_TIMEOUT',
      partition_key: `${execution.execution_id}#probe`,
      directory: 'probe',
      slot_ms: slotStartMs(1),
    };
  }
  const declared = declaredTrialsOf(executionName)[sequence - 1];
  if (declared === undefined) {
    throw new RangeError(`${executionName} has no declared trial ${String(sequence)}; expected a BASE_SCENARIOS entry`);
  }
  return trialContext(executionName, execution, declared);
}

function trialContext(
  executionName: GoldenExecution,
  execution: ExecutionContext,
  trial: DeclaredTrialShape,
): TrialContext {
  const trialId = trialIdOf(executionName, trial.sequence);
  const directory = `trials/${trialId}`;
  return {
    execution,
    label: `${executionName}/trial-${String(trial.sequence)}`,
    caller: trial.variant_id,
    scenario: trial.scenario,
    trial: { trial_id: trialId, trial_manifest_sha256: linkSha256(`${directory}/trial-manifest.json`) },
    partition_key: `${execution.execution_id}#${trialId}`,
    directory,
    slot_ms: slotStartMs(trial.sequence),
  };
}

// Admission, provisioning and readiness have succeeded and the trials phase has begun (design
// §10.2 P1-P4) before the first trial is published.
function recordPhases(runner: GoldenSourceInstance): void {
  const phases = [
    ['LEASE_ACQUISITION', 'succeeded', EXECUTION_OFFSETS.lease_acquired],
    ['PROVISIONING', 'succeeded', EXECUTION_OFFSETS.provisioning_succeeded],
    ['READINESS', 'succeeded', EXECUTION_OFFSETS.readiness_succeeded],
    ['TRIALS', 'started', EXECUTION_OFFSETS.trials_started],
  ] as const;
  for (const [phase, status, atMs] of phases) {
    runner.emit('phase_transition_recorded', atMs, { phase, status, reasons: [] });
  }
}

function recordTrialRunnerEvents(
  runner: GoldenSourceInstance,
  context: TrialContext,
  simulated: SimulatedTrial,
  settlement: SettlementOutcome,
): void {
  const trialPair: JsonObject = context.trial ?? {};
  runner.emit('trial_partitions_verified_absent', context.slot_ms + SLOT_OFFSETS.partitions_verified_absent, {
    ...trialPair,
    partition_key: context.partition_key,
    table_roles: [...TRIAL_PARTITION_TABLE_ROLES],
  });
  if (context.caller === 'probe' || context.scenario === 'COMMIT_THEN_TIMEOUT') {
    runner.emit('treatment_armed', context.slot_ms + SLOT_OFFSETS.treatment_armed, {
      ...trialPair,
      partition_key: context.partition_key,
      treatment_state: 'ARMED',
      treatment_version: 1,
    });
  }
  recordWorkload(runner, context, simulated);
  runner.emit('settlement_assessed', settlement.assessed_ms, { ...trialPair, ...settlement.assessment });
}

// A trial publishes its message (BR-RUA-036); the probe invokes its caller synchronously instead
// (BR-RUA-027) and records the response.
function recordWorkload(runner: GoldenSourceInstance, context: TrialContext, simulated: SimulatedTrial): void {
  const invocation = simulated.probe_invocation;
  if (invocation !== undefined) {
    runner.emit('probe_workload_invoked', invocation.ended_ms + 5, {
      lambda_request_id: invocation.lambda_request_id,
      status_code: 200,
      executed_version: GOLDEN_PROVIDER_VERSION,
    });
    return;
  }
  const message = trialPath(context, 'inputs/published-message.json');
  const trialId = context.trial?.trial_id ?? context.partition_key;
  runner.emit('trial_message_published', publishedMs(context), {
    ...context.trial,
    variant_id: context.caller,
    message_id: messageIdOf(context),
    sequence_number: sequenceNumberOf(context),
    md5_of_message_body: linkMd5(message),
    message_body_sha256: linkSha256(message),
    message_group_id: trialId,
    message_deduplication_id: trialId,
  });
}
