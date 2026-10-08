// Property tests of the public redacted copy's text rules (close-out Phase 3, testing rule 6: the
// redaction rewrites serialized evidence). Any JSON object whose keys and strings mix plain text
// with the account id (in ARNs, bucket names and alone), checkout, home and temporary paths
// redacts to JSON that still parses, equals the object with each string redacted on its own, holds
// no identifier, and redacts to itself again.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { leaksIn, redactText } from '../../../tools/lib/evidence-redaction.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const ACCOUNT = '123456789012';
const segment = fc.stringMatching(/^[\w.-]{1,8}$/);
// Plain text never holds a digit, a slash or a JSON escape, so every identifier stays one token.
const plain = fc.stringMatching(/^[a-z ,:;=_()-]{1,10}$/);
const identifier = fc.oneof(
  fc.constant(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:caller`),
  fc.constant(`cdk-hnb659fds-assets-${ACCOUNT}-us-east-1`),
  fc.constant(ACCOUNT),
  fc.tuple(segment, segment).map(([user, folder]) => `file:///Users/${user}/${folder}/study-1/infra/a.ts:5:1`),
  fc.tuple(segment, segment).map(([user, rest]) => `/home/${user}/${rest}`),
  fc.tuple(segment, segment).map(([a, b]) => `/private/var/folders/${a}/${b}/T/rua-x/report.json`),
);
const carrier = fc.array(fc.tuple(plain, identifier), { maxLength: 4 }).map((parts) => parts.flat().join(''));
const document = fc.dictionary(carrier, fc.oneof(carrier, fc.array(carrier, { maxLength: 3 }), fc.integer()), {
  maxKeys: 4,
});

function redactStrings(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return redactText(value, ACCOUNT).text;
  }
  if (Array.isArray(value)) {
    return value.map(redactStrings);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, one]) => [redactText(key, ACCOUNT).text, redactStrings(one)]),
  );
}

describe('redactText over serialized JSON', () => {
  it('keeps the JSON valid and equal to the value with each string redacted, holding no identifier', () => {
    fc.assert(
      fc.property(document, (value) => {
        const redacted = redactText(JSON.stringify(value), ACCOUNT).text;
        assert.deepEqual(JSON.parse(redacted), redactStrings(value));
        assert.deepEqual(leaksIn(redacted, ACCOUNT), []);
      }),
      fuzzParameters(),
    );
  });

  it('redacts its own output to itself, applying no rule', () => {
    fc.assert(
      fc.property(document, (value) => {
        const once = redactText(JSON.stringify(value), ACCOUNT).text;
        assert.deepEqual(redactText(once, ACCOUNT), { text: once, rules_applied: {} });
      }),
      fuzzParameters(),
    );
  });
});
