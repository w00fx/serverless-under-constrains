// The `cdk deploy --outputs-file` parser (design §9.8 D2; BR-RUA-040): exactly the deployed stack's
// outputs, CloudFormation keys with string values, sorted; anything else is OUTPUTS_UNREADABLE.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStackOutputs } from '../../../src/deployment-assembly/stack-outputs.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';

const encoder = new TextEncoder();

function parse(text: string): ReturnType<typeof parseStackOutputs> {
  return parseStackOutputs(encoder.encode(text), RUN_STACK);
}

describe('parseStackOutputs', () => {
  it('returns the stack outputs sorted by key', () => {
    const parsed = parse(`{"${RUN_STACK}":{"ProviderVersion":"7","ControllerFunctionName":"fn","Empty":""}}`);
    assert.deepEqual(parsed, {
      ok: true,
      value: [
        { key: 'ControllerFunctionName', value: 'fn' },
        { key: 'Empty', value: '' },
        { key: 'ProviderVersion', value: '7' },
      ],
    });
  });

  it('accepts a stack with no outputs', () => {
    assert.deepEqual(parse(`{"${RUN_STACK}":{}}`), { ok: true, value: [] });
  });

  it('refuses bytes that are not a JSON object', () => {
    for (const text of ['', 'nope', '[]', '"x"', 'null']) {
      const parsed = parse(text);
      assert.equal(parsed.ok ? 'ok' : parsed.error.code, 'OUTPUTS_UNREADABLE', text);
      assert.equal(parsed.ok ? '' : parsed.error.subject, 'BR-RUA-040');
    }
    const array = parse('[]');
    assert.match(
      array.ok ? '' : array.error.detail,
      /^the outputs file is array \[\]; expected a JSON object keyed by stack name$/,
    );
    const broken = parse('{');
    assert.match(broken.ok ? '' : broken.error.detail, /not one UTF-8 JSON document/);
  });

  it('refuses a file that is not exactly the deployed stack mapped to an object', () => {
    const cases = [
      '{}',
      '{"SucRua-run-00000000":{}}',
      `{"${RUN_STACK}":{},"Other":{}}`,
      `{"${RUN_STACK}":"x"}`,
      `{"${RUN_STACK}":[]}`,
    ];
    for (const text of cases) {
      const parsed = parse(text);
      assert.equal(parsed.ok ? 'ok' : parsed.error.code, 'OUTPUTS_UNREADABLE', text);
    }
    const other = parse('{"Other":{}}');
    assert.match(
      other.ok ? '' : other.error.detail,
      /names stacks \["Other"\]; expected exactly "SucRua-run-3f1c2a9e" mapped to an object/,
    );
  });

  it('reads the stack as an own member only', () => {
    const parsed = parseStackOutputs(encoder.encode('{"__proto__":{}}'), '__proto__');
    assert.equal(parsed.ok, true);
    assert.equal(parseStackOutputs(encoder.encode('{"a":{}}'), 'constructor').ok, false);
  });

  it('refuses an output whose key is not letters and digits or whose value is not a string', () => {
    for (const output of ['"Bad-Key":"x"', '"":"x"', '"Version":7', '"Version":null', '"Version":{"a":1}']) {
      const parsed = parse(`{"${RUN_STACK}":{${output}}}`);
      assert.equal(parsed.ok ? 'ok' : parsed.error.code, 'OUTPUTS_UNREADABLE', output);
    }
    const numeric = parse(`{"${RUN_STACK}":{"Version":7}}`);
    assert.match(
      numeric.ok ? '' : numeric.error.detail,
      /^output "Version" is number 7; expected a key of letters and digits with a string value$/,
    );
  });
});
