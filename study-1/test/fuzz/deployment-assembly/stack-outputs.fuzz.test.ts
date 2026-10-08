// The `cdk deploy --outputs-file` parser is total over untrusted bytes (A-05; design §12.5): it
// returns a value or an OUTPUTS_UNREADABLE reason for any bytes and any JSON, an accepted file
// always yields key-sorted entries of letters-and-digits keys with string values, and every
// well-formed outputs object of the deployed stack round-trips to its sorted entries.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parseStackOutputs } from '../../../src/deployment-assembly/stack-outputs.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';

const encoder = new TextEncoder();
const KEY = /^[A-Za-z0-9]+$/;

function checkAccepted(result: ReturnType<typeof parseStackOutputs>): void {
  if (!result.ok) {
    assert.deepEqual([result.error.code, result.error.subject], ['OUTPUTS_UNREADABLE', 'BR-RUA-040']);
    return;
  }
  const keys = result.value.map((entry) => entry.key);
  assert.deepEqual(keys, keys.toSorted());
  assert.ok(result.value.every((entry) => KEY.test(entry.key) && typeof entry.value === 'string'));
}

describe('parseStackOutputs is total (A-05)', () => {
  it('returns entries or one reason for any bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        checkAccepted(parseStackOutputs(bytes, RUN_STACK));
      }),
      fuzzParameters(),
    );
  });

  it('returns entries or one reason for any JSON keyed by the stack or not (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), fc.boolean(), (outputs, underStack) => {
        const document = underStack ? { [RUN_STACK]: outputs } : outputs;
        checkAccepted(parseStackOutputs(encoder.encode(JSON.stringify(document)), RUN_STACK));
      }),
      fuzzParameters(),
    );
  });

  it('round-trips every well-formed outputs object to its sorted entries (property)', () => {
    const outputs = fc.dictionary(fc.stringMatching(/^[A-Za-z0-9]{1,12}$/), fc.string({ maxLength: 40 }), {
      maxKeys: 12,
    });
    fc.assert(
      fc.property(outputs, (written) => {
        const parsed = parseStackOutputs(encoder.encode(JSON.stringify({ [RUN_STACK]: written })), RUN_STACK);
        const expected = Object.entries(written)
          .map(([key, value]) => ({ key, value }))
          .toSorted((a, b) => (a.key < b.key ? -1 : 1));
        assert.deepEqual(parsed, { ok: true, value: expected });
      }),
      fuzzParameters(),
    );
  });
});
