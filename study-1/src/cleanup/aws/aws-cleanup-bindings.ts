// The AWS-bound cleanup ports of one execution (BR-RUA-048, BR-RUA-051): the composition root of
// the runner and of `rua recover` binds them through the same discovery targets
// (`discoveryTargetsOf`), so a recovery acts on and audits exactly what the original cleanup did.
// The barrier release (`control-barrier-release.ts` over the item store), the sleeper, the
// auditor and the evidence steps are bound by their own features.

import type { StepPorts } from '../cleanup-step-dispatch.ts';
import type { DiscoveryTargets } from '../discovery-targets.ts';
import { CapturedDlqMessageDeletion } from '../dlq-message-deletion.ts';
import { AwsDiscoverySurfaces } from './aws-discovery-surfaces.ts';
import { AwsResourceDeleter } from './aws-resource-deleter.ts';
import type { CleanupAwsClients } from './cleanup-aws-clients.ts';
import { CloudFormationStackApi } from './cloudformation-stack-api.ts';
import { LambdaConsumerControl } from './lambda-consumer-control.ts';
import { LambdaDurableExecutions } from './lambda-durable-executions.ts';
import { SqsDlqMessageQueue } from './sqs-dlq-message-queue.ts';

/** The cleanup ports this module binds to AWS. */
export type AwsCleanupPorts = Pick<
  StepPorts,
  'consumers' | 'durableExecutions' | 'dlq' | 'stacks' | 'surfaces' | 'deleter'
>;

/**
 * Binds cleanup's AWS ports to one execution's discovery targets.
 *
 * @example
 * const targets = discoveryTargetsOf({ manifest, execution });
 * if (targets.ok) bindAwsCleanupPorts(createCleanupAwsClients(), targets.value);
 */
export function bindAwsCleanupPorts(clients: CleanupAwsClients, targets: DiscoveryTargets): AwsCleanupPorts {
  return {
    consumers: new LambdaConsumerControl(clients.lambda),
    durableExecutions: new LambdaDurableExecutions(clients.lambda, targets.durable_functions),
    dlq: new CapturedDlqMessageDeletion(new SqsDlqMessageQueue(clients.sqs), targets.dlq_urls),
    stacks: new CloudFormationStackApi(clients.cloudformation),
    surfaces: new AwsDiscoverySurfaces(clients, targets),
    deleter: new AwsResourceDeleter(clients),
  };
}
