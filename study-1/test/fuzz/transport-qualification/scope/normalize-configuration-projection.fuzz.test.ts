// normalizeConfigurationProjection is total over generated templates and schema-valid property
// paths (BR-RUA-028; testing rule 6, A-05). The example cases are in test/unit/transport-qualification/scope/normalize-configuration-projection.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import {
  normalizeConfigurationProjection,
  projectedResourceJson,
} from '../../../../src/transport-qualification/scope/configuration-projection.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { SAMPLE_POLICY } from '../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import { PROTOTYPE_MEMBER_NAMES } from '../../../unit/transport-qualification/scope/support/template-samples.ts';

describe('normalizeConfigurationProjection', () => {
  it('is total over generated templates and schema-valid property paths (property)', () => {
    const validator = createRecordValidator();
    const segment = fc.oneof(
      fc.constantFrom(...PROTOTYPE_MEMBER_NAMES, 'Properties', 'Timeout', 'Role', 'Metadata', 'Type', 'Fn', 'Ref'),
      fc.stringMatching(/^[A-Za-z0-9]{1,6}$/),
    );
    const propertyPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join('.'));
    const keyName = fc.constantFrom(...PROTOTYPE_MEMBER_NAMES, 'Timeout', 'Role', 'Fn', 'Ref', 'Fn::GetAtt', 'Tags');
    // JSON values plus the non-finite numbers JSON.parse yields for 1e400 (A-05).
    const nonFinite = fc.constantFrom<JsonValue>(Infinity, -Infinity, Number.NaN);
    const propertyValue = fc.oneof(
      fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
      nonFinite,
      fc.array(fc.oneof(nonFinite, fc.integer()), { maxLength: 2 }),
    );
    const resource = fc.record(
      {
        Type: fc.constantFrom('AWS::Lambda::Function', 'AWS::IAM::Role', 'AWS::SQS::Queue'),
        Properties: fc.dictionary(keyName, propertyValue, { maxKeys: 4 }),
        Metadata: fc.oneof(
          fc.record({
            'aws:cdk:path': fc.constantFrom('S/ExperimentCore/Fn/Resource', 'S/Other/Fn/Resource', 'S'),
          }),
          fc.dictionary(keyName, fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>, { maxKeys: 2 }),
        ),
      },
      { requiredKeys: ['Type'] },
    );
    const template = fc.dictionary(
      fc.constantFrom('Fn', 'Role', 'Queue', 'Other', ...PROTOTYPE_MEMBER_NAMES),
      resource,
      {
        maxKeys: 4,
      },
    );
    const propertyPaths = fc
      .tuple(propertyPath, fc.uniqueArray(propertyPath, { maxLength: 3 }))
      .map(([first, rest]): ConfigurationProjectionPolicy['property_paths'] => [
        first,
        ...rest.filter((path) => path !== first),
      ]);
    const projection = fc.record({
      projection_id: fc.constantFrom('experiment_core__functions', 'other', 'fn'),
      resource_type: fc.constantFrom('AWS::Lambda::Function', 'AWS::SQS::Queue'),
      property_paths: propertyPaths,
    });
    fc.assert(
      fc.property(template, projection, (resources, generated) => {
        const policy = { ...SAMPLE_POLICY, configuration_projections: [generated] };
        assert.equal(validator.validateAs('transport_scope_policy', policy as never).valid, true);
        const projected = normalizeConfigurationProjection({ Resources: resources }, generated);
        if (projected.ok) {
          // Every projected value is JSON the canonical writer accepts (it throws on a function).
          assert.equal(typeof canonicalJson(projected.value.map(projectedResourceJson)), 'string');
        } else {
          assert.ok(
            ['PROJECTION_SELECTS_NOTHING', 'TEMPLATE_INVALID', 'TEMPLATE_WITHOUT_PATH_METADATA'].includes(
              projected.error.code,
            ),
            JSON.stringify(projected.error),
          );
        }
      }),
      fuzzParameters(),
    );
  });
});
