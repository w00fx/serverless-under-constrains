// Deterministic names of run-owned resources (design §9.7, BR-RUA-050). The leak audit
// (BR-RUA-051) finds untaggable or tag-lagging resources by these names, so every construct
// takes its name from here. This module stays free of CDK imports so `src/cleanup` can use it.

import type { ExecutionKind, Uuid4, VariantId } from '../../src/record-contract/primitives.ts';

export const STUDY_LOG_GROUP_ROOT = '/suc/study-1';
export const RUN_OWNED_TABLE_ROLES = [
  'ledger',
  'experiment-journal',
  'caller-journal',
  'control',
  'trial-registry',
] as const;
export type RunOwnedTableRole = (typeof RUN_OWNED_TABLE_ROLES)[number];
export type QueueKind = 'source' | 'dlq';

const STACK_KIND: Readonly<Record<ExecutionKind, string>> = {
  RUN: 'run',
  TRANSPORT_PROBE: 'probe',
  VARIANT_VALIDATION: 'validation',
};
const LOGICAL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_ROLE_NAME_LENGTH = 64;

/**
 * The short execution prefix `<p>`: the first 8 hex digits of the execution id.
 *
 * @example
 * executionPrefix('3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4); // '3f1c2a9e'
 */
export function executionPrefix(executionId: Uuid4): string {
  return executionId.slice(0, 8);
}

/**
 * The run-owned stack name `SucRua-<kind>-<p>`.
 *
 * @example
 * stackName('TRANSPORT_PROBE', id); // 'SucRua-probe-3f1c2a9e'
 */
export function stackName(kind: ExecutionKind, executionId: Uuid4): string {
  return `SucRua-${STACK_KIND[kind]}-${executionPrefix(executionId)}`;
}

/**
 * Table name `suc1-<p>-<role>`.
 *
 * @example
 * tableName(id, 'caller-journal'); // 'suc1-3f1c2a9e-caller-journal'
 */
export function tableName(executionId: Uuid4, role: RunOwnedTableRole): string {
  return `${resourceNamePrefix(executionId)}${role}`;
}

/**
 * FIFO queue name `suc1-<p>-<variant>-{source,dlq}.fifo`.
 *
 * @example
 * queueName(id, 'durable', 'dlq'); // 'suc1-3f1c2a9e-durable-dlq.fifo'
 */
export function queueName(executionId: Uuid4, variant: VariantId, kind: QueueKind): string {
  return `${resourceNamePrefix(executionId)}${variant}-${kind}.fifo`;
}

/**
 * The controller's standard on-failure queue `suc1-<p>-controller-failure` (Streams accept
 * only a standard queue as an on-failure destination).
 *
 * @example
 * controllerFailureQueueName(id); // 'suc1-3f1c2a9e-controller-failure'
 */
export function controllerFailureQueueName(executionId: Uuid4): string {
  return `${resourceNamePrefix(executionId)}controller-failure`;
}

/**
 * Prefix shared by every run-owned table, queue and role name: `suc1-<p>-`.
 *
 * @example
 * listQueues({ QueueNamePrefix: resourceNamePrefix(id) });
 */
export function resourceNamePrefix(executionId: Uuid4): string {
  return `suc1-${executionPrefix(executionId)}-`;
}

/**
 * Prefix of every log group of the execution: `/suc/study-1/<execution_id>/`.
 *
 * @example
 * describeLogGroups({ logGroupNamePrefix: logGroupNamePrefix(id) });
 */
export function logGroupNamePrefix(executionId: Uuid4): string {
  return `${STUDY_LOG_GROUP_ROOT}/${executionId}/`;
}

/**
 * Explicit stack-owned log group `/suc/study-1/<execution_id>/<logical>`.
 *
 * @example
 * logGroupName(id, 'refund-provider'); // '/suc/study-1/<id>/refund-provider'
 */
export function logGroupName(executionId: Uuid4, logicalName: string): string {
  return `${logGroupNamePrefix(executionId)}${checkedLogicalName(logicalName)}`;
}

/**
 * IAM role name `suc1-<p>-<logical>` (at most 64 characters).
 *
 * @example
 * roleName(id, 'refund-provider'); // 'suc1-3f1c2a9e-refund-provider'
 */
export function roleName(executionId: Uuid4, logicalName: string): string {
  const name = `${resourceNamePrefix(executionId)}${checkedLogicalName(logicalName)}`;
  if (name.length > MAX_ROLE_NAME_LENGTH) {
    throw new RangeError(
      `role name ${JSON.stringify(name)} has ${String(name.length)} characters; expected at most 64`,
    );
  }
  return name;
}

function checkedLogicalName(logicalName: string): string {
  if (!LOGICAL_NAME_PATTERN.test(logicalName)) {
    throw new RangeError(
      `logical name ${JSON.stringify(logicalName)}; expected lowercase kebab case ${LOGICAL_NAME_PATTERN.source}`,
    );
  }
  return logicalName;
}
