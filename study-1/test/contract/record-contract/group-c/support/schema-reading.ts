// Reads the committed group-C schemas from disk through the kernel parser, so tests can compare a
// schema location with an expectation stated elsewhere (the spec text, a TypeScript vocabulary or
// a generated rule block). Pointer resolution is the shared helper in
// test/support/record-contract/json-paths.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonDocument } from '../../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import type { GroupCRecordType } from '../../../../../src/record-contract/records/group-c/record-map.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../../../src/record-contract/schema-registry.ts';

/**
 * The path of the committed JSON Schema of one group-C record type.
 *
 * @example
 * groupCSchemaPath('oracle_result'); // '<schema root>/group-c/oracle_result.schema.json'
 */
export function groupCSchemaPath(recordType: GroupCRecordType): string {
  return join(DEFAULT_SCHEMA_ROOT, 'group-c', `${recordType}.schema.json`);
}

/**
 * The parsed JSON Schema of one group-C record type.
 *
 * @example
 * groupCSchemaOf('run_summary'); // { $schema: ..., title: 'run_summary (...)', ... }
 */
export function groupCSchemaOf(recordType: GroupCRecordType): JsonValue {
  const parsed = parseJsonDocument(readFileSync(groupCSchemaPath(recordType)));
  assert.ok(parsed.ok, `${recordType} schema parses`);
  return parsed.value;
}
