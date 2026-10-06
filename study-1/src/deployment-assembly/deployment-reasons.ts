// Structured reasons of the deployment assembly. Each names the rule it serves: BR-RUA-042 for the
// frozen assembly, its copy and its synthesis; BR-RUA-040 for provisioning and the resource
// manifest; BR-RUA-050 for ownership tags; BR-RUA-053 for the provider version; BR-RUA-007 for the
// deployment projection the equality comparison reads. Details name the offending value and the
// expected shape (clean-code rule).

import type { StructuredReason } from '../record-contract/primitives.ts';

export type DeploymentRuleId = 'BR-RUA-007' | 'BR-RUA-040' | 'BR-RUA-042' | 'BR-RUA-050' | 'BR-RUA-053';

/**
 * A reason of the deployment assembly.
 *
 * @example
 * deploymentReason('DEPLOY_COPY_NOT_EMPTY', 'BR-RUA-042', '"/tmp/x" holds 3 entries; expected an absent or empty directory');
 */
export function deploymentReason(code: string, subject: DeploymentRuleId, detail: string): StructuredReason {
  return { code, subject, detail };
}
