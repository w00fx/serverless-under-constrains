// CloudFormation binding of `StackApi` (BR-RUA-048 step 9, BR-RUA-050): the recorded stack is
// described and deleted by the id the resource manifest records, never by its name, so a stack
// of the same name that another execution created is never touched. Thin by construction: one
// request per call, the settled result handed to `sdk-call-outcomes.ts`, where "Stack with id …
// does not exist" and `DELETE_COMPLETE` read absent.

import { DeleteStackCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';

import type { StackApi, StackDeleteRequest, StackRead } from '../cleanup-ports.ts';
import { settleCleanupCall, stackDeleteOutcome, stackReadOutcome } from '../sdk-call-outcomes.ts';

/**
 * The recorded stack through CloudFormation.
 *
 * @example
 * const stacks = new CloudFormationStackApi(clients.cloudformation);
 * await stacks.describe(stackId); // { kind: 'present', status: 'CREATE_COMPLETE' }
 */
export class CloudFormationStackApi implements StackApi {
  readonly #cloudformation: CloudFormationClient;

  constructor(cloudformation: CloudFormationClient) {
    this.#cloudformation = cloudformation;
  }

  /** `DescribeStacks` by stack id. */
  async describe(stackId: string): Promise<StackRead> {
    const call = await settleCleanupCall(() =>
      this.#cloudformation.send(new DescribeStacksCommand({ StackName: stackId })),
    );
    return stackReadOutcome(call, stackId);
  }

  /** `DeleteStack` by stack id; the deletion completes asynchronously. */
  async requestDelete(stackId: string): Promise<StackDeleteRequest> {
    const call = await settleCleanupCall(() =>
      this.#cloudformation.send(new DeleteStackCommand({ StackName: stackId })),
    );
    return stackDeleteOutcome(call, stackId);
  }
}
