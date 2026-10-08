// The resource manifest builder over arbitrary post-deploy readings (BR-RUA-040; design §12.5):
// whatever DescribeStacks, ListStackResources, the configuration reads and the deployment report
// return, the manifest is valid against the resource_manifest schema, it is `succeeded` exactly
// when there is no reason, and otherwise `partial` exactly when a resource was kept.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type {
  ConfigurationReading,
  StackResourceSummary,
} from '../../../src/deployment-assembly/provisioning-readings.ts';
import { buildResourceManifest } from '../../../src/deployment-assembly/resource-manifest.ts';
import type { StackDescription } from '../../../src/deployment-assembly/resource-manifest.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { KeyValueEntry } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { declaredTags } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FIXTURE_IDS } from '../../support/deployment-assembly/execution-template-fixture.ts';
import { RECORDED_STACK_ID } from '../../support/deployment-assembly/recorded-stack-resources.ts';
import { deployedReport, succeededInput } from '../../support/deployment-assembly/resource-manifest-inputs.ts';

const validator = createRecordValidator();
const VERSION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-3f1c2a9e-provider:';

const identifier = fc.constantFrom('Queue', 'Mapping', FIXTURE_IDS.providerVersion, 'bad-id', '', 'X1');
const resourceArbitrary: fc.Arbitrary<StackResourceSummary> = fc.record(
  {
    logical_id: identifier,
    resource_type: fc.constantFrom('AWS::Lambda::Version', 'AWS::SQS::Queue', 'Custom::X', 'AWS::Lambda::Alias'),
    physical_id: fc.oneof(
      fc.constantFrom('', 'p-1'),
      fc.stringMatching(/^[0-9]{1,3}$/).map((number) => `${VERSION_ARN}${number}`),
    ),
    resource_status: fc.constantFrom('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'CREATE_FAILED', 'create_complete'),
  },
  { requiredKeys: ['logical_id', 'resource_type', 'resource_status'] },
);
const readingArbitrary: fc.Arbitrary<ConfigurationReading> = fc.record({
  logical_id: identifier,
  attribute_path: fc.constantFrom('BatchSize', 'A.B', 'a..b', ''),
  value: fc.oneof(
    fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
    fc.constant(Number.NaN as unknown as JsonValue),
  ),
});
const outputArbitrary: fc.Arbitrary<KeyValueEntry> = fc.record({
  key: fc.constantFrom('ProviderVersion', 'Bad-Key', 'X', ''),
  value: fc.string({ maxLength: 8 }),
});
const stackArbitrary: fc.Arbitrary<StackDescription | undefined> = fc.option(
  fc.record({
    stack_id: fc.constantFrom(RECORDED_STACK_ID, 'not-an-arn', RECORDED_STACK_ID.replace('3f1c2a9e', '00000000')),
    stack_status: fc.constantFrom('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'ROLLBACK_COMPLETE'),
    tags: fc.constantFrom(declaredTags(), declaredTags().slice(1), [...declaredTags(), { key: 'suc:x', value: 'y' }]),
  }),
  { nil: undefined },
);

describe('buildResourceManifest over arbitrary readings', () => {
  it('is schema-valid, succeeded exactly without reasons, partial exactly with kept resources (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.array(resourceArbitrary, { maxLength: 6 }), { nil: undefined }),
        fc.array(readingArbitrary, { maxLength: 4 }),
        fc.array(outputArbitrary, { maxLength: 3 }),
        stackArbitrary,
        fc.boolean(),
        fc.constantFrom('SucRua-run-3f1c2a9e', 'SucRua-run-00000000'),
        (resources, configuration, outputs, stack, deployed, stackName) => {
          const built = buildResourceManifest(
            succeededInput({
              resources,
              configuration,
              stack,
              deploy: deployedReport({ deployed, outputs, stack_name: stackName }),
            }),
          );
          assert.ok(built.ok);
          const { manifest, reasons } = built.value;
          const verdict = validator.validateAs('resource_manifest', manifest as unknown as JsonValue);
          assert.ok(verdict.valid, JSON.stringify(verdict.valid ? [] : verdict.violations));
          assert.equal(manifest.provisioning_status === 'succeeded', reasons.length === 0);
          if (reasons.length > 0) {
            assert.equal(manifest.provisioning_status, manifest.resources.length > 0 ? 'partial' : 'failed');
          }
        },
      ),
      fuzzParameters(),
    );
  });
});
