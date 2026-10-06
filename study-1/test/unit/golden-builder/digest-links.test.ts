// Digest links between golden fixture files (BR-RUA-033): serialization writes canonical bytes,
// replaces each `@sha256`, `@md5` or `@text` link with the digest or text of the exact bytes it
// names, follows links through files that hold links themselves, leaves literal digests alone,
// and reports links to absent files and link cycles instead of throwing.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  defineMember,
  linkMd5,
  linkSha256,
  linkText,
  mapStrings,
  serializeScenarioFiles,
} from '../../support/golden-builder/digest-links.ts';
import type { FixtureFileContent } from '../../support/golden-builder/digest-links.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const decoder = new TextDecoder();
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: Uint8Array | string): string => createHash('md5').update(bytes).digest('hex');

function serialized(entries: readonly (readonly [string, FixtureFileContent])[]): ReadonlyMap<string, string> {
  const result = serializeScenarioFiles(new Map(entries));
  assert.ok(result.ok, `expected serialization to succeed: ${result.ok ? '' : result.error.join('; ')}`);
  return new Map([...result.value].map(([path, bytes]) => [path, decoder.decode(bytes)]));
}

describe('digest links', () => {
  it('spells the three link kinds', () => {
    assert.equal(linkSha256('a/b.json'), '@sha256(a/b.json)');
    assert.equal(linkMd5('a/b.json'), '@md5(a/b.json)');
    assert.equal(linkText('a/b.json'), '@text(a/b.json)');
  });

  it('writes one canonical line per record with a trailing newline', () => {
    const files = serialized([
      ['a.json', { kind: 'json', record: { b: 1, a: [true, null, 'x'] } }],
      ['b.jsonl', { kind: 'jsonl', records: [{ z: 1, y: 2 }, { x: 'é' }] }],
      ['c.jsonl', { kind: 'jsonl', records: [] }],
    ]);
    assert.equal(files.get('a.json'), '{"a":[true,null,"x"],"b":1}\n');
    assert.equal(files.get('b.jsonl'), '{"y":2,"z":1}\n{"x":"é"}\n');
    assert.equal(files.get('c.jsonl'), '');
  });

  it('resolves links over the exact stored bytes, through chains of linked files', () => {
    const files = serialized([
      ['payment.json', { kind: 'json', record: { amount_minor: 10000 } }],
      ['manifest.json', { kind: 'json', record: { payment_sha256: linkSha256('payment.json') } }],
      [
        'journal.jsonl',
        {
          kind: 'jsonl',
          records: [{ m: linkSha256('manifest.json'), md5: linkMd5('payment.json'), body: linkText('payment.json') }],
        },
      ],
    ]);
    const payment = '{"amount_minor":10000}\n';
    const manifest = `{"payment_sha256":"${sha256(payment)}"}\n`;
    assert.equal(files.get('manifest.json'), manifest);
    assert.equal(
      files.get('journal.jsonl'),
      `${JSON.stringify({ body: payment, m: sha256(manifest), md5: md5(payment) })}\n`,
    );
  });

  it('resolves links nested in arrays and objects, and leaves near-links and literal digests alone', () => {
    const literal = 'a'.repeat(64);
    const files = serialized([
      ['t.json', { kind: 'json', record: 'x' }],
      [
        'u.json',
        {
          kind: 'json',
          record: { deep: [[{ d: linkSha256('t.json') }]], literal, near: ' @sha256(t.json)', other: '@sha1(t.json)' },
        },
      ],
    ]);
    assert.equal(
      files.get('u.json'),
      `{"deep":[[{"d":"${sha256('"x"\n')}"}]],"literal":"${literal}","near":" @sha256(t.json)","other":"@sha1(t.json)"}\n`,
    );
  });

  it('reports a link to a file the scenario does not hold, for every file that depends on it', () => {
    const result = serializeScenarioFiles(
      new Map<string, FixtureFileContent>([
        ['a.json', { kind: 'json', record: { d: linkSha256('missing.json') } }],
        ['b.json', { kind: 'json', record: { d: linkSha256('a.json') } }],
      ]),
    );
    assert.deepEqual(result, {
      ok: false,
      error: ['a digest link names "missing.json", which the scenario does not hold; expected a fixture file path'],
    });
  });

  it('reports a cycle of links, naming the chain', () => {
    const result = serializeScenarioFiles(
      new Map<string, FixtureFileContent>([
        ['a.json', { kind: 'json', record: { d: linkSha256('b.json') } }],
        ['b.json', { kind: 'json', record: [linkMd5('a.json')] }],
        ['self.json', { kind: 'json', record: linkText('self.json') }],
      ]),
    );
    assert.ok(!result.ok);
    const problems = result.error;
    assert.ok(problems.includes('digest links form a cycle a.json -> b.json -> a.json; expected acyclic links'));
    assert.ok(problems.includes('digest links form a cycle self.json -> self.json; expected acyclic links'));
  });

  it('maps every string of a value, keeping inherited-looking member names as own members', () => {
    const value: JsonValue = JSON.parse('{"__proto__":["a",{"constructor":"b"}],"n":1,"t":true,"z":null}') as JsonValue;
    const mapped = mapStrings(value, (text) => text.toUpperCase());
    assert.equal(JSON.stringify(mapped), '{"__proto__":["A",{"constructor":"B"}],"n":1,"t":true,"z":null}');
    assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
    assert.equal(
      mapStrings('s', (text) => `${text}!`),
      's!',
    );
  });

  it('maps a value nested past the call stack without overflowing it', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = parsedTower(shape, DEEP_NESTING);
      const files = serializeScenarioFiles(new Map([['deep.json', { kind: 'json', record: tower }]]));
      assert.ok((files.ok ? (files.value.get('deep.json')?.length ?? 0) : 0) > DEEP_NESTING);
      assert.equal(
        structurallyEqual(
          mapStrings(tower, (text) => text),
          tower,
        ),
        true,
      );
    }
  });

  it('defines a member as an own enumerable writable property', () => {
    const target: Record<string, JsonValue> = {};
    defineMember(target, '__proto__', 1);
    assert.equal(Object.hasOwn(target, '__proto__'), true);
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, '__proto__'), {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
});
