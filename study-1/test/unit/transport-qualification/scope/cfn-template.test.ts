// The template read model behind the configuration projections (BR-RUA-028).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listTemplateResources, valueAtPath } from '../../../../src/transport-qualification/scope/cfn-template.ts';

describe('listTemplateResources', () => {
  it('lists each resource with its construct path below the stack, undefined without path metadata', () => {
    const template = {
      Resources: {
        Fn1: {
          Type: 'AWS::Lambda::Function',
          Properties: { Timeout: 3 },
          Metadata: { 'aws:cdk:path': 'Stack/Core/Fn/Resource' },
        },
        Bare: { Type: 'AWS::SQS::Queue' },
        OnlyStack: { Type: 'AWS::SNS::Topic', Metadata: { 'aws:cdk:path': 'Stack' } },
        NoPath: { Type: 'AWS::SNS::Topic', Metadata: { other: 'x' } },
        NumericPath: { Type: 'AWS::SNS::Topic', Metadata: { 'aws:cdk:path': 7 } },
      },
    };
    assert.deepEqual(listTemplateResources(template), {
      ok: true,
      value: [
        {
          logical_id: 'Fn1',
          type: 'AWS::Lambda::Function',
          construct_path: ['Core', 'Fn', 'Resource'],
          resource: template.Resources.Fn1,
        },
        { logical_id: 'Bare', type: 'AWS::SQS::Queue', construct_path: undefined, resource: template.Resources.Bare },
        {
          logical_id: 'OnlyStack',
          type: 'AWS::SNS::Topic',
          construct_path: [],
          resource: template.Resources.OnlyStack,
        },
        {
          logical_id: 'NoPath',
          type: 'AWS::SNS::Topic',
          construct_path: undefined,
          resource: template.Resources.NoPath,
        },
        {
          logical_id: 'NumericPath',
          type: 'AWS::SNS::Topic',
          construct_path: undefined,
          resource: template.Resources.NumericPath,
        },
      ],
    });
  });

  it('reads only own Resources, Type and Metadata members', () => {
    const resource = Object.create({ Metadata: { 'aws:cdk:path': 'Stack/Inherited/Resource' } }) as Record<
      string,
      unknown
    >;
    resource['Type'] = 'AWS::SQS::Queue';
    const listed = listTemplateResources({ Resources: { Q: resource } } as never);
    assert.deepEqual(listed.ok ? listed.value.map((entry) => entry.construct_path) : [], [undefined]);
    const inheritedType = Object.create({ Type: 'AWS::SQS::Queue' }) as Record<string, unknown>;
    assert.deepEqual(listTemplateResources({ Resources: { Q: inheritedType } } as never), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources.Q is {}; expected an object with a string Type',
      },
    });
    assert.deepEqual(listTemplateResources(Object.create({ Resources: {} }) as never), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources is absent; expected an object of resources',
      },
    });
  });

  it('accepts a template without resources', () => {
    assert.deepEqual(listTemplateResources({ Resources: {} }), { ok: true, value: [] });
  });

  it('refuses a missing or non-object Resources section', () => {
    assert.deepEqual(listTemplateResources({}), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources is absent; expected an object of resources',
      },
    });
    assert.deepEqual(listTemplateResources({ Resources: null }), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources is null; expected an object of resources',
      },
    });
  });

  it('refuses a resource that is not an object or has no string Type', () => {
    assert.deepEqual(listTemplateResources({ Resources: { A: 'text' } }), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources.A is "text"; expected an object with a string Type',
      },
    });
    assert.deepEqual(listTemplateResources({ Resources: { B: { Type: 3 } } }), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources.B is {"Type":3}; expected an object with a string Type',
      },
    });
  });
});

describe('valueAtPath', () => {
  const resource = { Properties: { Timeout: 30, Nested: { Flag: false, Empty: null }, List: [1] } };

  it('walks dot-separated object keys', () => {
    assert.equal(valueAtPath(resource, 'Properties.Timeout'), 30);
    assert.equal(valueAtPath(resource, 'Properties.Nested.Flag'), false);
    assert.equal(valueAtPath(resource, 'Properties.Nested.Empty'), null);
    assert.deepEqual(valueAtPath(resource, 'Properties.List'), [1]);
  });

  it('gives undefined for inherited Object.prototype members (regression: verify/inherited-path.ts)', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.equal(valueAtPath(resource, `Properties.${name}`), undefined, name);
      assert.equal(valueAtPath(resource, name), undefined, name);
      assert.equal(valueAtPath(resource, `Properties.Nested.${name}`), undefined, name);
    }
  });

  it('reads an own key named like an Object.prototype member', () => {
    const own = JSON.parse('{"Properties":{"constructor":{"valueOf":1},"__proto__":2}}') as Parameters<
      typeof valueAtPath
    >[0];
    assert.deepEqual(valueAtPath(own, 'Properties.constructor'), { valueOf: 1 });
    assert.equal(valueAtPath(own, 'Properties.constructor.valueOf'), 1);
    assert.equal(valueAtPath(own, 'Properties.__proto__'), 2);
  });

  it('gives undefined for an absent key or a path through a non-object', () => {
    assert.equal(valueAtPath(resource, 'Properties.Missing'), undefined);
    assert.equal(valueAtPath(resource, 'Properties.Timeout.Inner'), undefined);
    assert.equal(valueAtPath(resource, 'Properties.List.0'), undefined);
    assert.equal(valueAtPath(resource, 'Properties.Missing.Deeper'), undefined);
  });
});
