// AWS binding of `ResourceDeleter` (BR-RUA-048 step 9): sends the one delete request
// `resource-deletion-requests.ts` chose for a remaining owned resource and hands the settled
// result to `sdk-call-outcomes.ts`: a resource the service no longer knows is already absent
// (AC-RUA-011), and any other failure (`DeleteConflict` of a role that still has policies
// included) is a failed deletion. An inline `AWS::IAM::Policy` has no direct delete here: it
// stays behind the stack boundary. A running durable execution is stopped as step 5 stops one
// (`lambda-durable-executions.ts`): a refused stop is followed by a status read, so one that
// ended after the surface saw it is already absent, not a failed deletion.

import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteRoleCommand } from '@aws-sdk/client-iam';
import { DeleteAliasCommand, DeleteEventSourceMappingCommand, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';

import type { ResourceDeleter, ResourceDeletion } from '../cleanup-ports.ts';
import type { DiscoveredResource } from '../discovery.ts';
import type { DeletionRequest } from '../resource-deletion-requests.ts';
import { deletionPlanOf } from '../resource-deletion-requests.ts';
import { deletionOutcome, settleCleanupCall, stopAsDeletion } from '../sdk-call-outcomes.ts';
import type { CleanupAwsClients } from './cleanup-aws-clients.ts';
import { LambdaDurableExecutions } from './lambda-durable-executions.ts';

/** Every delete request but the stop of a durable execution, which goes through its own port. */
type DirectDeleteRequest = Exclude<DeletionRequest, { readonly operation: 'StopDurableExecution' }>;

/**
 * Direct deletes through the service each resource belongs to.
 *
 * @example
 * await new AwsResourceDeleter(clients).delete(resource); // { kind: 'deleted' }
 */
export class AwsResourceDeleter implements ResourceDeleter {
  readonly #clients: CleanupAwsClients;
  readonly #durable: LambdaDurableExecutions;

  constructor(clients: CleanupAwsClients) {
    this.#clients = clients;
    this.#durable = new LambdaDurableExecutions(clients.lambda, []);
  }

  /** Deletes one resource; never throws. */
  async delete(resource: DiscoveredResource): Promise<ResourceDeletion> {
    const plan = deletionPlanOf(resource);
    if (plan.kind === 'unsupported') {
      return { kind: 'failed', reason: plan.reason };
    }
    const { request } = plan;
    if (request.operation === 'StopDurableExecution') {
      return stopAsDeletion(await this.#durable.stop(request.execution_arn));
    }
    const call = await settleCleanupCall(() => this.#send(request));
    return deletionOutcome(call, resource.identifier);
  }

  #send(request: DirectDeleteRequest): Promise<unknown> {
    const { lambda, sqs, dynamodb, logs, iam } = this.#clients;
    switch (request.operation) {
      case 'DeleteFunction':
        return lambda.send(
          new DeleteFunctionCommand({ FunctionName: request.function_name, Qualifier: request.qualifier }),
        );
      case 'DeleteAlias':
        return lambda.send(new DeleteAliasCommand({ FunctionName: request.function_name, Name: request.alias_name }));
      case 'DeleteEventSourceMapping':
        return lambda.send(new DeleteEventSourceMappingCommand({ UUID: request.mapping_id }));
      case 'DeleteQueue':
        return sqs.send(new DeleteQueueCommand({ QueueUrl: request.queue_url }));
      case 'DeleteTable':
        return dynamodb.send(new DeleteTableCommand({ TableName: request.table_name }));
      case 'DeleteLogGroup':
        return logs.send(new DeleteLogGroupCommand({ logGroupName: request.log_group_name }));
      case 'DeleteRole':
        return iam.send(new DeleteRoleCommand({ RoleName: request.role_name }));
    }
  }
}
