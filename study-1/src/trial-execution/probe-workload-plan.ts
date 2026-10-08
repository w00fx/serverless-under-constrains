// The plan of the transport probe's workload (design §10.2 P4 for the probe; BR-RUA-027,
// BR-RUA-040, OR-RUA-001, OR-RUA-002). Everything the probe acts on is derived from the frozen
// probe manifest (identity, financial inputs, timing) and the deployed stack's published versions
// (stack outputs `ProviderVersion` and `ProbeCallerVersion`), so the probe can only run what
// admission and provisioning froze. The payload of the single Invoke is the canonical
// `probe_workload_request`: the probe's identity and manifest digest, the declared payment and
// refund request, and the approved amount.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';
import type { ProbeWorkloadPlan } from './trial-execution-ports.ts';

/** The published versions the probe's stack deployed (design §9.7 stack outputs). */
export interface ProbeWorkloadTargets {
  readonly provider_version: string;
  readonly probe_caller_version: string;
}

// A Lambda published version is a positive decimal number; `$LATEST` or an alias is never one.
const PUBLISHED_VERSION = /^[1-9][0-9]*$/;

/**
 * The payment and approved decision the manifest declares once for every trial or the probe
 * (OR-RUA-001), as the records the unit's `inputs/` holds.
 *
 * @example
 * declaredFinancialRecords(manifest).payment.payment_id; // 'pay-poc-001'
 */
export function declaredFinancialRecords(manifest: ExecutionManifest): {
  readonly payment: Payment;
  readonly approved_decision: ApprovedDecision;
} {
  const inputs = manifest.financial_inputs;
  return {
    payment: {
      schema_version: 1,
      record_type: 'payment',
      payment_id: inputs.payment_id,
      captured_amount_minor: inputs.captured_amount_minor,
      currency: inputs.currency,
    },
    approved_decision: {
      schema_version: 1,
      record_type: 'approved_decision',
      refund_request_id: inputs.refund_request_id,
      payment_id: inputs.payment_id,
      decision: inputs.decision,
      approved_amount_minor: inputs.approved_amount_minor,
      currency: inputs.currency,
    },
  };
}

/**
 * The probe's workload plan, or why there is none: the manifest is not a transport probe's, or
 * a target is not a published version.
 *
 * @example
 * const plan = planProbeWorkload(manifest, manifestSha256, { provider_version: '3', probe_caller_version: '1' });
 * if (plan.ok) plan.value.request.record_type; // 'probe_workload_request'
 */
export function planProbeWorkload(
  manifest: ExecutionManifest,
  manifestSha256: Sha256Hex,
  targets: ProbeWorkloadTargets,
): Result<ProbeWorkloadPlan, StructuredReason> {
  if (manifest.execution_kind !== 'TRANSPORT_PROBE') {
    return err(planReason(`the manifest declares a ${manifest.execution_kind}, not a TRANSPORT_PROBE`));
  }
  const unpublished = (['provider_version', 'probe_caller_version'] as const).find(
    (name) => !PUBLISHED_VERSION.test(targets[name]),
  );
  if (unpublished !== undefined) {
    return err(planReason(`${unpublished} ${boundedJsonText(targets[unpublished])} is not a published version number`));
  }
  const financial = declaredFinancialRecords(manifest);
  const inputs = manifest.financial_inputs;
  return ok({
    execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: manifest.transport_probe_id },
    execution_manifest_sha256: manifestSha256,
    ...financial,
    provider_timing: {
      safety_release_ms: manifest.timing.provider_safety_release_ms,
      treatment_poll_interval_ms: manifest.timing.treatment_poll_interval_ms,
    },
    provider_version: targets.provider_version,
    probe_caller_version: targets.probe_caller_version,
    request: {
      schema_version: 1,
      record_type: 'probe_workload_request',
      transport_probe_id: manifest.transport_probe_id,
      execution_manifest_sha256: manifestSha256,
      payment_id: inputs.payment_id,
      refund_request_id: inputs.refund_request_id,
      amount_minor: inputs.approved_amount_minor,
      currency: inputs.currency,
    },
  });
}

function planReason(problem: string): StructuredReason {
  return {
    code: 'PROBE_PLAN_INVALID',
    subject: 'BR-RUA-027',
    detail: `${problem}; expected a frozen transport-probe manifest and the stack's published provider and probe caller versions`,
  };
}
