// Reads the committed group-B schemas from disk, so tests can compare a schema location with an
// expectation stated elsewhere (the spec text or a TypeScript vocabulary).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonDocument } from '../../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import type { GroupBRecordType } from '../../../../../src/record-contract/records/group-b/record-map.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../../../src/record-contract/schema-registry.ts';

/**
 * The parsed JSON Schema of one group-B record type.
 *
 * @example
 * schemaOf('dispatch_started'); // { $schema: ..., title: 'dispatch_started (...)', ... }
 */
export function schemaOf(recordType: GroupBRecordType): JsonValue {
  const parsed = parseJsonDocument(readFileSync(join(DEFAULT_SCHEMA_ROOT, 'group-b', `${recordType}.schema.json`)));
  assert.ok(parsed.ok, `${recordType} schema parses`);
  return parsed.value;
}
