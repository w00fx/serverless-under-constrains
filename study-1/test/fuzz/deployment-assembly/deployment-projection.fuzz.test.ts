// The deployment projection reader is total over frozen template bytes (A-05, A-13; design
// §12.5): any bytes, and the fixture run template with any property of any resource replaced by
// any JSON value or removed, give a projection or reasons, never a throw. An accepted projection
// cites exactly the bytes it read, and a rejected one has a reason for every refusal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIXTURE_IDS,
  propertiesAt,
  runTemplate,
  templateBytes,
} from '../../support/deployment-assembly/execution-template-fixture.ts';

const CODES = new Set(['TEMPLATE_UNREADABLE', 'TEMPLATE_RESOURCE_MISSING']);
const PROPERTY_NAMES = [
  'FunctionName',
  'BatchSize',
  'FifoQueue',
  'RedrivePolicy',
  'Environment',
  'DurableConfig',
  'StreamSpecification',
  'Timeout',
  'ScalingConfig',
  'DestinationConfig',
  'constructor',
];

function project(bytes: Uint8Array): ReturnType<typeof projectDeploymentTemplate> {
  return projectDeploymentTemplate({
    template_path: 't.json',
    template_bytes: bytes,
    template_sha256: sha256Hex(bytes),
  });
}

function checkProjection(bytes: Uint8Array): void {
  const result = project(bytes);
  if (result.ok) {
    assert.deepEqual(result.value.evidence_refs, [{ artifact_path: 't.json', artifact_sha256: sha256Hex(bytes) }]);
    return;
  }
  assert.ok(result.error.length > 0);
  assert.ok(
    result.error.every((reason) => CODES.has(reason.code)),
    JSON.stringify(result.error),
  );
}

describe('projectDeploymentTemplate is total (A-05)', () => {
  it('returns a projection or reasons for any bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        checkProjection(bytes);
      }),
      fuzzParameters(),
    );
  });

  it('returns a projection or reasons for any property of any resource replaced or removed (property)', () => {
    const ids = Object.values(FIXTURE_IDS);
    fc.assert(
      fc.property(
        fc.constantFrom(...ids),
        fc.constantFrom(...PROPERTY_NAMES),
        fc.option(fc.jsonValue({ maxDepth: 3 }), { nil: undefined }),
        (id, property, value) => {
          const template = runTemplate();
          const properties = propertiesAt(template, id);
          if (value === undefined) {
            Reflect.deleteProperty(properties, property);
          } else {
            properties[property] = value as JsonValue;
          }
          checkProjection(templateBytes(template));
        },
      ),
      fuzzParameters(),
    );
  });

  it('returns a projection or reasons for any resource replaced by any JSON value (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.values(FIXTURE_IDS)), fc.jsonValue({ maxDepth: 3 }), (id, value) => {
        const template = runTemplate();
        (template['Resources'] as Record<string, JsonValue>)[id] = value as JsonValue;
        checkProjection(templateBytes(template));
      }),
      fuzzParameters(),
    );
  });
});
