// A recorded ListStackResources answer for a template (design §9.13 case 2, §9.8 D4): every
// template resource as CloudFormation lists it after a successful create, with the physical ids
// it assigns. A Lambda version's physical id is its version ARN, ending in the version number;
// the other ids are stable names derived from the logical id. Fixture values, not cloud evidence.

import type { StackResourceSummary } from '../../../src/deployment-assembly/provisioning-readings.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';

export const RECORDED_ACCOUNT = '123456789012';
export const RECORDED_STACK_ID =
  'arn:aws:cloudformation:us-east-1:123456789012:stack/SucRua-run-3f1c2a9e/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/**
 * The resources of `template` as ListStackResources reports them, each `CREATE_COMPLETE`, with
 * every `AWS::Lambda::Version` published as `versionNumber`.
 *
 * @example
 * recordedStackResources(JSON.parse(templateText), '7'); // [{ logical_id, resource_type, physical_id, resource_status }, ...]
 */
export function recordedStackResources(template: JsonObject, versionNumber: string): StackResourceSummary[] {
  const resources = template['Resources'] as Readonly<Record<string, { readonly Type: string }>>;
  return Object.entries(resources).map(([logicalId, resource]) => ({
    logical_id: logicalId,
    resource_type: resource.Type,
    physical_id:
      resource.Type === 'AWS::Lambda::Version'
        ? `arn:aws:lambda:us-east-1:${RECORDED_ACCOUNT}:function:suc1-3f1c2a9e-${logicalId.slice(0, 20)}:${versionNumber}`
        : `suc1-3f1c2a9e-${logicalId.toLowerCase()}`,
    resource_status: 'CREATE_COMPLETE',
  }));
}
