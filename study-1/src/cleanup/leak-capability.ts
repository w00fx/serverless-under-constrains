// D-30: what a leaked resource could still do (BR-RUA-031, BR-RUA-052, AC-RUA-050). BR-RUA-052
// says "a leak capable of producing later correlated processing or monetary effects compromises
// settlement and comparison eligibility"; a leak that can only hold bytes or grant access does
// not. The class depends only on the resource type:
// - `processing_capable`: code that can still run or be triggered: functions, their versions
//   and aliases, event-source mappings, running durable executions, and a remaining stack
//   (every run stack contains functions and mappings, design §9.2);
// - `storage_only`: queues, tables and log groups, which hold data but run nothing;
// - `identity`: roles, policies and resource permissions, which grant access but run nothing;
// - `unknown`: every other type. It compromises isolation too, because nothing proves it cannot
//   process.

import type { LeakCapabilityClass } from '../record-contract/records/group-c/vocabulary.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from './resource-types.ts';

const CAPABILITY_BY_TYPE: ReadonlyMap<string, Exclude<LeakCapabilityClass, 'unknown'>> = new Map([
  [STACK_RESOURCE_TYPE, 'processing_capable'],
  [FUNCTION_RESOURCE_TYPE, 'processing_capable'],
  [FUNCTION_VERSION_RESOURCE_TYPE, 'processing_capable'],
  [FUNCTION_ALIAS_RESOURCE_TYPE, 'processing_capable'],
  [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, 'processing_capable'],
  [DURABLE_EXECUTION_RESOURCE_TYPE, 'processing_capable'],
  [QUEUE_RESOURCE_TYPE, 'storage_only'],
  [TABLE_RESOURCE_TYPE, 'storage_only'],
  [LOG_GROUP_RESOURCE_TYPE, 'storage_only'],
  [ROLE_RESOURCE_TYPE, 'identity'],
  ['AWS::IAM::Policy', 'identity'],
  ['AWS::IAM::ManagedPolicy', 'identity'],
  ['AWS::Lambda::Permission', 'identity'],
  ['AWS::SQS::QueuePolicy', 'identity'],
] as const);

/**
 * The D-30 capability class of a leaked resource, from its type alone.
 *
 * @example
 * classifyLeakCapability({ resource_type: 'AWS::Lambda::EventSourceMapping' }); // 'processing_capable'
 * classifyLeakCapability({ resource_type: 'AWS::DynamoDB::Table' }); // 'storage_only'
 * classifyLeakCapability({ resource_type: 'AWS::S3::Bucket' }); // 'unknown'
 */
export function classifyLeakCapability(resource: { readonly resource_type: string }): LeakCapabilityClass {
  return CAPABILITY_BY_TYPE.get(resource.resource_type) ?? 'unknown';
}

/**
 * Whether a leak compromises isolation, settlement and comparison eligibility (D-30,
 * BR-RUA-052): only a `processing_capable` or `unknown` leak does.
 *
 * @example
 * leakCompromisesIsolation({ capability_class: 'storage_only' }); // false
 * leakCompromisesIsolation({ capability_class: 'unknown' }); // true
 */
export function leakCompromisesIsolation(leak: { readonly capability_class: LeakCapabilityClass }): boolean {
  return leak.capability_class === 'processing_capable' || leak.capability_class === 'unknown';
}
