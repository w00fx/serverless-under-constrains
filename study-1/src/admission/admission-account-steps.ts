// Admission steps A6..A10 (design §10.1): read-only checks of the toolchain, the account, the
// coordination baseline, the oracle and the selected qualification. Each step's reads happen
// only after the previous step passed, so a rejected attempt stops reading at its first failure.

import type { Result } from '../record-contract/primitives.ts';
import type { OracleRevisionCheck } from '../record-contract/records/group-c/oracle_revision_check.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { planExecutionResources } from '../safety/resource-plan.ts';
import { safetyLimitsFor } from '../safety/safety-limits.ts';
import type {
  AdmissionPorts,
  AdmissionRequest,
  CallerIdentity,
  GoldenSuiteRun,
  PortFailure,
} from './admission-ports.ts';
import type { AdmissionAttempt, StepContinuation } from './admission-attempt.ts';
import { portFailureReason } from './admission-reason.ts';
import { assessCallerIdentity } from './caller-identity-check.ts';
import { assessCapabilities } from './capability-check.ts';
import type { AdmittedCapabilities } from './capability-check.ts';
import { assessCoordination } from './coordination-check.ts';
import { OR_RUA_002_TIMING } from './declared-inputs.ts';
import type { LocalInputs } from './admission-local-steps.ts';
import { assessOracleAttestation } from './oracle-attestation.ts';
import { failed } from './preflight-check.ts';
import type { StepVerdict } from './preflight-check.ts';
import { assessQualification } from './qualification-check.ts';
import type { SelectedProbe } from './qualification-check.ts';

/** What A6..A10 admit. */
export interface AccountReadiness {
  readonly capabilities: AdmittedCapabilities;
  readonly caller: CallerIdentity;
  readonly oracle: OracleRevisionCheck;
  readonly selected: SelectedProbe | null;
}

/**
 * Steps A6..A10, each recorded before the next runs.
 *
 * @example
 * const account = await assessAccountReadiness(request, local, ports, attempt);
 * if (account.kind === 'continue') account.value.oracle.result; // 'passed'
 */
export async function assessAccountReadiness(
  request: AdmissionRequest,
  local: LocalInputs,
  ports: AdmissionPorts,
  attempt: AdmissionAttempt,
): Promise<StepContinuation<AccountReadiness>> {
  const capabilities = await attempt.record('A6', await capabilityVerdict(request, local, ports));
  if (capabilities.kind === 'stop') {
    return capabilities;
  }
  const caller = await attempt.record(
    'A7',
    assessCallerIdentity(await ports.sts.readCallerIdentity(), local.environment.account_id),
  );
  if (caller.kind === 'stop') {
    return caller;
  }
  const environment = local.environment.input;
  const [table, lease] = await Promise.all([
    ports.coordination.readCoordinationTable(environment.coordination_table_arn),
    ports.lease.read(),
  ]);
  const coordination = await attempt.record('A8', assessCoordination({ table, lease }, environment));
  if (coordination.kind === 'stop') {
    return coordination;
  }
  const oracle = await attempt.record(
    'A9',
    oracleVerdict(await ports.goldenSuite.readGoldenSuiteRun(), local, capabilities.value, attempt, ports),
  );
  if (oracle.kind === 'stop') {
    return oracle;
  }
  const selected = await attempt.record('A10', await qualificationVerdict(request, ports));
  if (selected.kind === 'stop') {
    return selected;
  }
  return {
    kind: 'continue',
    value: { capabilities: capabilities.value, caller: caller.value, oracle: oracle.value, selected: selected.value },
  };
}

async function capabilityVerdict(
  request: AdmissionRequest,
  local: LocalInputs,
  ports: AdmissionPorts,
): Promise<StepVerdict<AdmittedCapabilities>> {
  const target = local.inputs.target;
  const plan = planExecutionResources({
    kind: target.kind,
    ...(target.kind === 'VARIANT_VALIDATION' ? { variant_id: target.variant } : {}),
    active_ms: safetyLimitsFor(request.kind).active_ms,
    treatment_poll_interval_ms: OR_RUA_002_TIMING.treatment_poll_interval_ms,
  });
  const [toolchain, concurrency, bootstrap] = await Promise.all([
    ports.toolchain.readToolchain(),
    ports.lambdaAccount.readUnreservedConcurrency(),
    ports.bootstrap.readBootstrapStackStatus(),
  ]);
  return assessCapabilities({
    toolchain,
    unreserved_concurrency: concurrency,
    bootstrap_status: bootstrap,
    required_concurrency: Number(plan.resource_counts['functions']),
  });
}

function oracleVerdict(
  run: Result<GoldenSuiteRun, PortFailure>,
  local: LocalInputs,
  capabilities: AdmittedCapabilities,
  attempt: AdmissionAttempt,
  ports: AdmissionPorts,
): StepVerdict<OracleRevisionCheck> {
  if (!run.ok) {
    return failed('SAFETY', { subject: 'oracle_revision_check', expected: 'golden_suite_run' }, [
      portFailureReason('ORACLE_NOT_FINAL', 'BR-RUA-055', 'the golden suite run', run.error),
    ]);
  }
  return assessOracleAttestation(run.value, {
    admission_attempt_id: attempt.admission_attempt_id,
    commit_sha: local.source.commit_sha,
    tree_sha: local.source.tree_sha,
    node_version: String(capabilities.tool_versions['node']),
    checked_at: formatUtcMillis(ports.clock.now()),
  });
}

async function qualificationVerdict(
  request: AdmissionRequest,
  ports: AdmissionPorts,
): Promise<StepVerdict<SelectedProbe | null>> {
  const selection = request.qualification;
  const reading =
    request.kind === 'TRANSPORT_PROBE' || selection === undefined
      ? undefined
      : await ports.packages.readProbePackage(selection);
  return assessQualification(request.kind, selection, reading, ports.validator);
}
