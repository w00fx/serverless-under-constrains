// Totality of the deployment-assembly readers over hostile input (Owner amendment A-05): bytes
// nested 100,000 levels deep, numbers past the double range, and member names that an object
// inherits (`constructor`, `__proto__`, `toString`). Every reader returns a value or a reason and
// never throws, and an inherited name is never read as present.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import { readExecutionTemplate, referencedLogicalIds } from '../../../src/deployment-assembly/execution-template.ts';
import { checkConfiguration } from '../../../src/deployment-assembly/provisioning-readings.ts';
import { parseStackOutputs } from '../../../src/deployment-assembly/stack-outputs.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { DEEP_NESTING, parsedTower, towerText } from '../../support/kernel/deep-json.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';
import {
  FIXTURE_IDS,
  propertiesAt,
  runTemplate,
  templateBytes,
} from '../../support/deployment-assembly/execution-template-fixture.ts';

const encoder = new TextEncoder();
const DEEP_FILTER = 'deep-filter-placeholder';
const DEEP_TARGET = 'deep-target-placeholder';

describe('deployment-assembly readers over hostile input (A-05)', () => {
  it('read 100,000-level towers as reasons, never a RangeError', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = encoder.encode(towerText(shape, DEEP_NESTING, '1'));
      assert.equal(readExecutionTemplate(tower).ok, false, shape);
      assert.equal(parseStackOutputs(tower, RUN_STACK).ok, false, shape);
      const projected = projectDeploymentTemplate({
        template_path: 't.json',
        template_bytes: tower,
        template_sha256: sha256Hex(tower),
      });
      assert.equal(projected.ok, false, shape);
    }
  });

  it('carry a deep property value of a template without throwing', () => {
    // JSON.stringify itself recurses, so the towers are spliced into the template text.
    const template = runTemplate();
    propertiesAt(template, FIXTURE_IDS.conventionalMapping)['FilterCriteria'] = DEEP_FILTER;
    propertiesAt(template, FIXTURE_IDS.providerVersion)['FunctionName'] = DEEP_TARGET;
    const text = new TextDecoder()
      .decode(templateBytes(template))
      .replace(`"${DEEP_FILTER}"`, towerText('mixed', DEEP_NESTING, '1'))
      .replace(`"${DEEP_TARGET}"`, towerText('object', DEEP_NESTING, `{"Ref":"${FIXTURE_IDS.providerFunction}"}`));
    const bytes = encoder.encode(text);
    const read = readExecutionTemplate(bytes);
    assert.equal(read.ok, true);
    assert.deepEqual(referencedLogicalIds(parsedTower('array')), []);
    const projected = projectDeploymentTemplate({
      template_path: 't.json',
      template_bytes: bytes,
      template_sha256: sha256Hex(bytes),
    });
    assert.ok(projected.ok);
    assert.equal(projected.value.variants.conventional.message_source_protocol['filter_criteria'] !== null, true);
  });

  it('check a deep configuration value and an output value of a deep stack', () => {
    const checked = checkConfiguration([
      { logical_id: 'Mapping', attribute_path: 'FilterCriteria', value: parsedTower('array') },
    ]);
    assert.equal(checked.entries.length, 1);
    const deepOutputs = encoder.encode(`{"${RUN_STACK}":{"Deep":${towerText('array', DEEP_NESTING, '1')}}}`);
    const parsed = parseStackOutputs(deepOutputs, RUN_STACK);
    assert.equal(parsed.ok ? 'ok' : parsed.error.code, 'OUTPUTS_UNREADABLE');
    assert.ok(parsed.ok || parsed.error.detail.length < 2_000);
  });

  it('refuse numbers past the double range', () => {
    const big = encoder.encode('{"Resources":{"A":{"Type":"AWS::SQS::Queue","Properties":{"Delay":1e400}}}}');
    assert.equal(readExecutionTemplate(big).ok ? 'ok' : 'refused', 'refused');
    const checked = checkConfiguration([{ logical_id: 'Q', attribute_path: 'Delay', value: Number.POSITIVE_INFINITY }]);
    assert.deepEqual(
      checked.reasons.map((reason) => reason.code),
      ['CONFIGURATION_ENTRY_INVALID'],
    );
    const outputs = parseStackOutputs(encoder.encode(`{"${RUN_STACK}":{"V":1e400}}`), RUN_STACK);
    assert.equal(outputs.ok, false);
  });

  it('never read an inherited member name as present', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(parseStackOutputs(encoder.encode('{"Other":{}}'), name).ok, false, name);
    }
    const template = runTemplate();
    const caller = propertiesAt(template, FIXTURE_IDS.durableCaller);
    delete caller['DurableConfig'];
    caller['Environment'] = {};
    const bytes = templateBytes(template);
    const projected = projectDeploymentTemplate({
      template_path: 't.json',
      template_bytes: bytes,
      template_sha256: sha256Hex(bytes),
    });
    assert.ok(projected.ok);
    assert.deepEqual(projected.value.variants.durable.caller_strategy, { execution_strategy: 'sqs_redelivery' });
    assert.equal(projected.value.variants.durable.caller_timing['provider_qualifier'], 'unqualified');
    const inherited = readExecutionTemplate(encoder.encode('{"Resources":{"toString":{"Type":"AWS::SQS::Queue"}}}'));
    assert.equal(inherited.ok ? inherited.value.byLogicalId.get('toString')?.type : '', 'AWS::SQS::Queue');
  });
});
