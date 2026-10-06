// The read model of the frozen execution template (design §9.1, §9.2; BR-RUA-042, BR-RUA-053):
// resources indexed by construct path and logical id, total over bytes that are not a template,
// one resource per path or path prefix, and the provider's published version identified by its
// path, its type and the function it publishes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CORE_TEMPLATE_PATHS,
  providerVersionLogicalId,
  readExecutionTemplate,
  referencedLogicalIds,
  resourceProperties,
  templateResourceAt,
  templateResourceUnder,
  variantTemplatePaths,
} from '../../../src/deployment-assembly/execution-template.ts';
import type { ExecutionTemplate } from '../../../src/deployment-assembly/execution-template.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  FIXTURE_IDS,
  propertiesAt,
  removeResource,
  resourceAt,
  runTemplate,
  templateBytes,
} from '../../support/deployment-assembly/execution-template-fixture.ts';

const encoder = new TextEncoder();

function readTemplate(template: JsonObject = runTemplate()): ExecutionTemplate {
  const read = readExecutionTemplate(templateBytes(template));
  if (!read.ok) {
    throw new Error(`fixture template unreadable: ${read.error.detail}`);
  }
  return read.value;
}

function errorCode(
  result: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } },
): string {
  return result.ok ? 'ok' : result.error.code;
}

describe('readExecutionTemplate', () => {
  it('indexes every resource by logical id and those with a construct path by that path', () => {
    const template = runTemplate();
    resourceAt(template, FIXTURE_IDS.controllerFailure)['Metadata'] = {};
    const read = readTemplate(template);
    assert.equal(read.byLogicalId.size, 16);
    assert.equal(read.byPath.size, 15);
    assert.equal(read.byPath.get(CORE_TEMPLATE_PATHS.providerFunction)?.logical_id, FIXTURE_IDS.providerFunction);
    assert.equal(read.byLogicalId.get(FIXTURE_IDS.controllerFailure)?.construct_path, undefined);
  });

  it('refuses bytes that are not one JSON object of finite values', () => {
    const cases = ['not json', '[1]', '{"Resources":{},"Big":1e400}', '"text"'];
    for (const text of cases) {
      const read = readExecutionTemplate(encoder.encode(text));
      assert.equal(errorCode(read), 'TEMPLATE_UNREADABLE', text);
      assert.equal(read.ok ? '' : read.error.subject, 'BR-RUA-042');
    }
    const invalid = readExecutionTemplate(encoder.encode('ÿ'));
    assert.match(invalid.ok ? '' : invalid.error.detail, /not one UTF-8 JSON document/);
  });

  it('refuses an object without the CloudFormation resource shape', () => {
    const missing = readExecutionTemplate(encoder.encode('{"Outputs":{}}'));
    const untyped = readExecutionTemplate(encoder.encode('{"Resources":{"A":{"Properties":{}}}}'));
    assert.deepEqual([errorCode(missing), errorCode(untyped)], ['TEMPLATE_UNREADABLE', 'TEMPLATE_UNREADABLE']);
    assert.match(untyped.ok ? '' : untyped.error.detail, /Resources\.A/);
  });
});

describe('templateResourceAt and templateResourceUnder', () => {
  it('finds a resource by its construct path and names a missing one', () => {
    const template = readTemplate();
    assert.equal(errorCode(templateResourceAt(template, CORE_TEMPLATE_PATHS.controllerMapping)), 'ok');
    const missing = templateResourceAt(template, 'ExperimentCore/Absent/Resource');
    assert.equal(errorCode(missing), 'TEMPLATE_RESOURCE_MISSING');
    assert.match(missing.ok ? '' : missing.error.detail, /"ExperimentCore\/Absent\/Resource"/);
  });

  it('finds exactly one resource under a prefix that ends in /Resource', () => {
    const template = runTemplate();
    const paths = variantTemplatePaths('conventional');
    const under = templateResourceUnder(readTemplate(template), paths.mappingPrefix);
    assert.equal(under.ok ? under.value.logical_id : '', FIXTURE_IDS.conventionalMapping);
    resourceAt(template, FIXTURE_IDS.durableMapping)['Metadata'] = {
      'aws:cdk:path': `SucRua-run-3f1c2a9e/${paths.mappingPrefix}Other/Resource`,
    };
    const twice = templateResourceUnder(readTemplate(template), paths.mappingPrefix);
    assert.match(twice.ok ? '' : twice.error.detail, /^2 resources have a construct path under/);
  });

  it('ignores a path under the prefix that is not a /Resource leaf, and reports none found', () => {
    const template = runTemplate();
    const paths = variantTemplatePaths('durable');
    resourceAt(template, FIXTURE_IDS.durableMapping)['Metadata'] = {
      'aws:cdk:path': `SucRua-run-3f1c2a9e/${paths.mappingPrefix}Queue/Default`,
    };
    const none = templateResourceUnder(readTemplate(template), paths.mappingPrefix);
    assert.equal(errorCode(none), 'TEMPLATE_RESOURCE_MISSING');
    assert.match(none.ok ? '' : none.error.detail, /^0 resources/);
  });
});

describe('variantTemplatePaths', () => {
  it('names each variant construct path below the stack', () => {
    assert.deepEqual(variantTemplatePaths('conventional'), {
      callerFunction: 'ConventionalVariant/Caller/Function/Resource',
      callerAlias: 'ConventionalVariant/Caller/Function/Aliaslive/Resource',
      sourceQueue: 'ConventionalVariant/Source/Queue/Resource',
      deadLetterQueue: 'ConventionalVariant/Source/DeadLetterQueue/Resource',
      mappingPrefix: 'ConventionalVariant/Caller/Function/Aliaslive/SqsEventSource:',
    });
    assert.equal(variantTemplatePaths('durable').callerFunction, 'DurableVariant/Caller/Function/Resource');
  });
});

describe('providerVersionLogicalId (BR-RUA-053)', () => {
  it('is the Lambda version at the core path that publishes the provider function', () => {
    assert.deepEqual(providerVersionLogicalId(readTemplate()), { ok: true, value: FIXTURE_IDS.providerVersion });
  });

  it('is missing when the provider function or its version is absent', () => {
    for (const id of [FIXTURE_IDS.providerFunction, FIXTURE_IDS.providerVersion]) {
      const template = runTemplate();
      removeResource(template, id);
      assert.equal(errorCode(providerVersionLogicalId(readTemplate(template))), 'TEMPLATE_RESOURCE_MISSING', id);
    }
  });

  it('refuses a resource of another type, of another function, or of several functions', () => {
    const wrongType = runTemplate();
    resourceAt(wrongType, FIXTURE_IDS.providerVersion)['Type'] = 'AWS::Lambda::Alias';
    const otherFunction = runTemplate();
    propertiesAt(otherFunction, FIXTURE_IDS.providerVersion)['FunctionName'] = { Ref: FIXTURE_IDS.controllerFunction };
    const several = runTemplate();
    propertiesAt(several, FIXTURE_IDS.providerVersion)['FunctionName'] = {
      'Fn::Join': ['', [{ Ref: FIXTURE_IDS.providerFunction }, { Ref: FIXTURE_IDS.controllerFunction }]],
    };
    const noTarget = runTemplate();
    delete propertiesAt(noTarget, FIXTURE_IDS.providerVersion)['FunctionName'];
    for (const template of [wrongType, otherFunction, several, noTarget]) {
      const result = providerVersionLogicalId(readTemplate(template));
      assert.equal(errorCode(result), 'PROVIDER_VERSION_UNREADABLE');
      assert.equal(result.ok ? '' : result.error.subject, 'BR-RUA-042');
    }
    const detail = providerVersionLogicalId(readTemplate(otherFunction));
    assert.match(
      detail.ok ? '' : detail.error.detail,
      /^ProviderVersion1 is a "AWS::Lambda::Version" of \["ControllerFunction"\]; expected an AWS::Lambda::Version of ProviderFunction$/,
    );
  });
});

describe('resourceProperties and referencedLogicalIds', () => {
  it('reads the properties object, or {} when a resource has none', () => {
    const template = runTemplate();
    resourceAt(template, FIXTURE_IDS.controllerFailure)['Properties'] = 'none';
    const read = readTemplate(template);
    const provider = read.byLogicalId.get(FIXTURE_IDS.providerFunction);
    const failure = read.byLogicalId.get(FIXTURE_IDS.controllerFailure);
    assert.ok(provider !== undefined && failure !== undefined);
    assert.equal(resourceProperties(provider)['Timeout'], 30);
    assert.deepEqual(resourceProperties(failure), {});
  });

  it('lists the ids a value refers to through Ref and Fn::GetAtt, in order', () => {
    assert.deepEqual(referencedLogicalIds({ 'Fn::GetAtt': ['ProviderVersion1', 'Version'] }), ['ProviderVersion1']);
    assert.deepEqual(
      referencedLogicalIds({ 'Fn::Join': ['', [{ Ref: 'A1' }, { 'Fn::GetAtt': ['B2', 'Arn'] }, 'Ref']] }),
      ['A1', 'B2'],
    );
    assert.deepEqual(referencedLogicalIds({ Ref: 'AWS::Region' }), []);
    assert.deepEqual(referencedLogicalIds('$LATEST'), []);
    assert.deepEqual(referencedLogicalIds(Number.POSITIVE_INFINITY), []);
  });
});
