// One canonical valid example per group A record type (design §6: schema, interface and a
// contract case with one canonical example), plus the variant examples that exercise the other
// branch of each conditional rule. Catalogue-wide tests iterate over these lists.

import type { JsonObject } from '../../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../../src/record-contract/record-types.ts';
import {
  admissionRejection,
  deploymentAssemblyInventory,
  failedPreflightCheck,
  passedPreflightCheck,
  sourceProvenance,
  transportScopePolicy,
  transportScopeSnapshot,
} from './admission-examples.ts';
import {
  approvedDecision,
  environmentInput,
  payment,
  probeProviderRefundCall,
  probeWorkloadRequest,
  rejectedResponse,
  succeededResponse,
  trialMessage,
  trialProviderRefundCall,
} from './input-examples.ts';
import {
  failedResourceManifest,
  probeExecutionManifest,
  probeProviderConfiguration,
  runExecutionManifest,
  succeededResourceManifest,
  trialManifest,
  trialProviderConfiguration,
  trialRegistration,
  validationExecutionManifest,
} from './manifest-examples.ts';
import { asJson } from './validation-assertions.ts';

export type GroupARecordType = (typeof RECORD_TYPE_GROUPS)['group-a'][number];

export interface NamedExample {
  readonly name: string;
  readonly record: JsonObject;
}

/** Exactly one canonical example per group A record type, keyed by record type. */
export const CANONICAL_EXAMPLES: Readonly<Record<GroupARecordType, () => JsonObject>> = {
  environment_input: () => asJson(environmentInput()),
  payment: () => asJson(payment()),
  approved_decision: () => asJson(approvedDecision()),
  trial_message: () => asJson(trialMessage()),
  provider_refund_call: () => asJson(trialProviderRefundCall()),
  provider_refund_response: () => asJson(succeededResponse()),
  probe_workload_request: () => asJson(probeWorkloadRequest()),
  admission_rejection: () => asJson(admissionRejection()),
  preflight_check_recorded: () => asJson(failedPreflightCheck()),
  source_provenance: () => asJson(sourceProvenance()),
  deployment_assembly_inventory: () => asJson(deploymentAssemblyInventory()),
  transport_scope_policy: () => asJson(transportScopePolicy()),
  transport_scope_snapshot: () => asJson(transportScopeSnapshot()),
  execution_manifest: () => asJson(runExecutionManifest()),
  resource_manifest: () => asJson(succeededResourceManifest()),
  trial_manifest: () => asJson(trialManifest()),
  provider_trial_configuration: () => asJson(trialProviderConfiguration()),
  trial_registration: () => asJson(trialRegistration()),
};

/** Every valid example: the canonical ones plus the other branch of each conditional rule. */
export function allValidExamples(): readonly NamedExample[] {
  const canonical = RECORD_TYPE_GROUPS['group-a'].map((type) => ({ name: type, record: CANONICAL_EXAMPLES[type]() }));
  return [
    ...canonical,
    { name: 'provider_refund_call (probe)', record: asJson(probeProviderRefundCall()) },
    { name: 'provider_refund_response (rejected)', record: asJson(rejectedResponse()) },
    { name: 'preflight_check_recorded (passed)', record: asJson(passedPreflightCheck()) },
    { name: 'execution_manifest (variant validation)', record: asJson(validationExecutionManifest()) },
    { name: 'execution_manifest (transport probe)', record: asJson(probeExecutionManifest()) },
    { name: 'resource_manifest (failed)', record: asJson(failedResourceManifest()) },
    { name: 'provider_trial_configuration (probe)', record: asJson(probeProviderConfiguration()) },
  ];
}
