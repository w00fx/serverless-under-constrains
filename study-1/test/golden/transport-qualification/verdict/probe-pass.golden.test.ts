// AC-RUA-002 and AC-RUA-021 goldens (design §14): the six conditions and the probe verdict derived
// from the base probe's frozen evidence, and the usability of that passing probe. The verdict cases
// state their expectations in their case files, from the spec; the usability case states it here:
// a passing, valid, faithful probe with verified evidence, no late evidence, a clean closure, no
// safety breach, an eligible package and an indexed scope snapshot is usable (BR-RUA-026).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../../src/record-contract/schema-registry.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { GOLDEN_VALIDATOR, HAPPENED_BEFORE_PATTERN, loadProbeCase } from './support/probe-golden.ts';
import { packageInput, probePackage } from './support/probe-package.ts';
import { assertVerdictCase } from './support/verdict-assertions.ts';

describe('AC-RUA-002 and AC-RUA-021 a clean probe passes and is usable', () => {
  it('ac002-condition-derivation', async () => {
    await assertVerdictCase('ac002-condition-derivation');
  });

  it('ac021-probe-verdict-pass', async () => {
    await assertVerdictCase('ac021-probe-verdict-pass');
  });

  // AC-RUA-002 forbids any happened-before proof claim. The case checks the members one result
  // carries; this checks no result can carry one: the closed schema declares no such property.
  it('ac002-no-happened-before-member-in-the-result-schema', () => {
    const path = join(DEFAULT_SCHEMA_ROOT, 'group-c', 'transport_probe_result.schema.json');
    const schema = parseJsonDocument(readFileSync(path));
    assert.ok(schema.ok, `${path} parses`);
    assert.equal(memberOf(schema.value, 'additionalProperties'), false);
    const declared = declaredProperties(schema.value);
    assert.ok(declared.includes('fidelity_basis'), 'the property walk reaches the result members');
    assert.deepEqual(
      declared.filter((name) => HAPPENED_BEFORE_PATTERN.test(name)),
      [],
    );
  });

  it('ac021-usable-probe-selectable', async () => {
    const loaded = await loadProbeCase('ac021-probe-verdict-pass');
    const deps = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
    const assessment = assessProbeUsability(readProbeUsabilityInput(packageInput(probePackage(loaded.files)), deps));
    assert.equal(assessment.probe_usability, 'usable');
    assert.deepEqual(assessment.reasons, []);
    assert.equal(
      GOLDEN_VALIDATOR.validateAs('probe_usability_assessment', assessment as unknown as JsonValue).valid,
      true,
    );
  });
});

function memberOf(value: JsonValue, member: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, member)
    ? (value as Readonly<Record<string, JsonValue>>)[member]
    : undefined;
}

// Every property name the schema declares, at any depth (nested `properties` and `$defs` included).
function declaredProperties(schema: JsonValue): readonly string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(declaredProperties);
  }
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const properties = memberOf(schema, 'properties');
  const own = typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  return [...own, ...Object.values(schema).flatMap(declaredProperties)];
}
