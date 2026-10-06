// Assertions shared by the cleanup integration tests: both frozen records are schema-valid, every
// journal line is a valid `cleanup_action_recorded`, and compact views of what cleanup did.

import assert from 'node:assert/strict';

import type { CleanupRunOutcome } from '../../../src/cleanup/cleanup-orchestrator.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { CleanupResult } from '../../../src/record-contract/records/group-c/cleanup_result.ts';
import type { CleanupWorld } from './cleanup-harness.ts';
import { cleanupValidator, journalHistory } from './cleanup-harness.ts';

/**
 * Fails unless both results are schema-valid, step 12 froze exactly them, and every journal
 * line the runs wrote reads back as a valid action of this execution.
 *
 * @example
 * assertConsistentOutcome(world, await cleanupOrchestrator(world).runNormal(cleanupInput(world)));
 */
export function assertConsistentOutcome(world: CleanupWorld, outcome: CleanupRunOutcome): void {
  for (const [type, record] of [
    ['cleanup_result', outcome.cleanup_result],
    ['leak_audit_result', outcome.leak_audit_result],
  ] as const) {
    const validation = cleanupValidator().validateAs(type, record as unknown as JsonValue);
    assert.ok(validation.valid, `${type} invalid: ${JSON.stringify(validation)}`);
  }
  const frozen = world.evidence.frozen().at(-1);
  assert.deepEqual(frozen, { cleanup_result: outcome.cleanup_result, leak_audit_result: outcome.leak_audit_result });
  assert.deepEqual(journalHistory(world).findings, []);
}

/**
 * `<resource_type> <identifier>` → `<action>/<ownership_basis>` for every resource entry.
 *
 * @example
 * resourceActions(result); // { 'AWS::CloudFormation::Stack arn:…': 'DELETED/recorded_stack' }
 */
export function resourceActions(result: CleanupResult): Record<string, string> {
  return Object.fromEntries(
    result.resources.map((resource) => [
      `${resource.resource_type} ${resource.resource_identifier}`,
      `${resource.action}/${resource.ownership_basis}`,
    ]),
  );
}

/**
 * Step number → status for every step in the result.
 *
 * @example
 * stepStatuses(result)[9]; // 'succeeded'
 */
export function stepStatuses(result: CleanupResult): Record<number, string> {
  return Object.fromEntries(result.steps.map((step) => [step.step, step.status]));
}
