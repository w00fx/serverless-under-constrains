// Assertions over the real catalogue validator: the committed group-B schemas and the shared
// `$defs`, read from disk by the production filesystem adapter (the boundary under test).

import assert from 'node:assert/strict';

import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../../../src/record-contract/schema-registry.ts';

export const groupBValidator = createRecordValidator();

/**
 * Each violation as `<instance_path> <keyword> <detail>`, empty when the value is valid.
 *
 * @example
 * violationsOf(withMember(json, 'phase', 'settled')); // ['/phase enum must be equal to ...']
 */
export function violationsOf(value: JsonValue): readonly string[] {
  const result: RecordValidation = groupBValidator.validate(value);
  if (result.valid) {
    return [];
  }
  return result.violations.map((violation) => `${violation.instance_path} ${violation.keyword} ${violation.detail}`);
}

/**
 * Asserts the value is a valid catalogued record.
 *
 * @example
 * assertAccepted(toJson(dispatchStarted()), 'canonical dispatch_started');
 */
export function assertAccepted(value: JsonValue, label: string): void {
  assert.deepEqual(violationsOf(value), [], `${label}: expected a valid record`);
}

/**
 * Asserts the value is rejected; with `expected`, one violation must start with it
 * (`<instance_path> <keyword>`), so the rejection is for the intended reason.
 *
 * @example
 * assertRejected(withMember(json, 'source', 'runner'), 'runner source', '/source enum');
 */
export function assertRejected(value: JsonValue, label: string, expected?: string): void {
  const violations = violationsOf(value);
  assert.notDeepEqual(violations, [], `${label}: expected a rejection`);
  if (expected === undefined) {
    return;
  }
  assert.ok(
    violations.some((violation) => violation.startsWith(`${expected} `)),
    `${label}: expected a violation "${expected}", got ${JSON.stringify(violations)}`,
  );
}

/**
 * Asserts the value is rejected because `property` is missing at the root.
 *
 * @example
 * assertMissing(withMember(json, 'failure', undefined), 'FAILED without failure', 'failure');
 */
export function assertMissing(value: JsonValue, label: string, property: string): void {
  const violations = violationsOf(value);
  assert.ok(
    violations.some((violation) => violation.startsWith(' required ') && violation.includes(`'${property}'`)),
    `${label}: expected "${property}" to be required, got ${JSON.stringify(violations)}`,
  );
}

/**
 * Asserts the value is rejected because a member present at `path` is forbidden there.
 *
 * @example
 * assertForbidden(withMember(json, 'trial_id', TRIAL_ID), 'execution-level trial', '/trial_id');
 */
export function assertForbidden(value: JsonValue, label: string, path: string): void {
  assertRejected(value, label, `${path} false schema`);
}
