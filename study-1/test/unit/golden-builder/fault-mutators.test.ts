// The scenario operations a golden case states its fault with (design §12.4): model operations
// edit records before serialization, so digest links follow the edit; byte operations edit the
// serialized bytes, so the digests other files hold stop matching. Each operation is checked for
// its effect, its `$trial/` alias expansion, and the result it returns instead of throwing.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { applyByteOperations } from '../../support/golden-builder/byte-operations.ts';
import type { ByteOperation } from '../../support/golden-builder/byte-operations.ts';
import { linkSha256, serializeScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import type { FixtureFileContent, ScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import { materializeCase } from '../../support/golden-builder/fixture-materializer.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import {
  applyModelOperations,
  expandSubjectAlias,
  selectRecord,
} from '../../support/golden-builder/scenario-operations.ts';
import type { ModelOperation } from '../../support/golden-builder/scenario-operations.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const SUBJECT = 'trials/t';
const JOURNAL = `${SUBJECT}/journals/caller-journal.jsonl`;
const PAYMENT = `${SUBJECT}/inputs/payment.json`;

function event(type: string, id: string, instance: string, sequence: number): JsonValue {
  return {
    record_type: type,
    event_id: id,
    source: 'conventional_caller',
    source_instance_id: instance,
    source_sequence: sequence,
  };
}

const FILES: ScenarioFiles = new Map<string, FixtureFileContent>([
  [PAYMENT, { kind: 'json', record: { amount_minor: 10000 } }],
  [`${SUBJECT}/trial-manifest.json`, { kind: 'json', record: { payment_sha256: linkSha256(PAYMENT) } }],
  [
    JOURNAL,
    {
      kind: 'jsonl',
      records: [
        event('dispatch_started', 'e1', 'i', 1),
        event('attempt_outcome_recorded', 'e2', 'i', 2),
        event('dispatch_started', 'e3', 'j', 1),
      ],
    },
  ],
]);

function applied(operations: readonly ModelOperation[]): ReadonlyMap<string, FixtureFileContent> {
  const result = applyModelOperations(FILES, operations, SUBJECT);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

function failure(operations: readonly ModelOperation[]): string {
  const result = applyModelOperations(FILES, operations, SUBJECT);
  return result.ok ? '<applied>' : result.error;
}

function lines(files: ReadonlyMap<string, FixtureFileContent>, path: string): readonly JsonValue[] {
  const content = files.get(path);
  return content?.kind === 'jsonl' ? content.records : [];
}

describe('subject alias', () => {
  it('expands $trial/ at the start of a path or a link target only', () => {
    assert.equal(expandSubjectAlias('$trial/a.json', SUBJECT), 'trials/t/a.json');
    assert.equal(expandSubjectAlias('@sha256($trial/a.json)', SUBJECT), '@sha256(trials/t/a.json)');
    assert.equal(expandSubjectAlias('@md5($trial/a.json)', SUBJECT), '@md5(trials/t/a.json)');
    assert.equal(expandSubjectAlias('@text($trial/a.json)', SUBJECT), '@text(trials/t/a.json)');
    assert.equal(expandSubjectAlias('x/$trial/a.json', SUBJECT), 'x/$trial/a.json');
    assert.equal(expandSubjectAlias('@sha1($trial/a.json)', SUBJECT), '@sha1($trial/a.json)');
  });
});

describe('record selection', () => {
  const records = lines(FILES, JOURNAL);

  it('selects by type and occurrence, by event id and by line', () => {
    assert.deepEqual(selectRecord(records, { record_type: 'dispatch_started' }), {
      ok: true,
      value: { index: 0, record: records[0] },
    });
    assert.equal(selectRecord(records, { record_type: 'dispatch_started', occurrence: 2 }).ok && 2, 2);
    assert.deepEqual(selectRecord(records, { event_id: 'e2' }), { ok: true, value: { index: 1, record: records[1] } });
    assert.deepEqual(selectRecord(records, { line: 3 }), { ok: true, value: { index: 2, record: records[2] } });
  });

  it('reports a selector that matches nothing', () => {
    for (const select of [
      { record_type: 'dispatch_started', occurrence: 3 },
      { record_type: 'toString' },
      { event_id: 'e9' },
      { line: 0 },
      { line: 4 },
      { line: 1.5 },
    ]) {
      const selected = selectRecord(records, select);
      assert.ok(!selected.ok);
      assert.match(selected.error, /^no record matches selector .*; expected exactly one match$/);
    }
  });
});

describe('model operations', () => {
  it('sets and removes members of a JSON file and of a selected JSONL record', () => {
    const files = applied([
      { op: 'set', path: '$trial/inputs/payment.json', pointer: '/amount_minor', value: 1 },
      {
        op: 'set',
        path: '$trial/journals/caller-journal.jsonl',
        select: { event_id: 'e2' },
        pointer: '/outcome',
        value: 'TIMED_OUT',
      },
      { op: 'remove', path: '$trial/journals/caller-journal.jsonl', select: { line: 1 }, pointer: '/source_sequence' },
      { op: 'remove', path: '$trial/trial-manifest.json', pointer: '/payment_sha256' },
    ]);
    assert.deepEqual(files.get(PAYMENT), { kind: 'json', record: { amount_minor: 1 } });
    assert.deepEqual(files.get(`${SUBJECT}/trial-manifest.json`), { kind: 'json', record: {} });
    const [first, second] = lines(files, JOURNAL);
    assert.equal(Object.hasOwn(first as object, 'source_sequence'), false);
    assert.equal((second as { outcome: string }).outcome, 'TIMED_OUT');
    assert.deepEqual(
      lines(FILES, JOURNAL)[1],
      event('attempt_outcome_recorded', 'e2', 'i', 2),
      'the input is unchanged',
    );
  });

  it('removes, inserts and clones records', () => {
    const files = applied([
      { op: 'remove_record', path: JOURNAL, select: { event_id: 'e1' } },
      { op: 'insert_record', path: JOURNAL, record: { record_type: 'tail' } },
      { op: 'insert_record', path: JOURNAL, record: { record_type: 'head' }, after: { line: 1 } },
      {
        op: 'clone_record',
        path: JOURNAL,
        select: { event_id: 'e3' },
        set: [
          { pointer: '/event_id', value: 'e4' },
          { pointer: '/x', value: 1 },
        ],
      },
    ]);
    assert.deepEqual(
      lines(files, JOURNAL).map((record) => [
        (record as { record_type: string }).record_type,
        (record as { event_id?: string }).event_id,
      ]),
      [
        ['attempt_outcome_recorded', 'e2'],
        ['head', undefined],
        ['dispatch_started', 'e3'],
        ['dispatch_started', 'e4'],
        ['tail', undefined],
      ],
    );
  });

  it('resequences each source instance densely in line order and leaves non-events alone', () => {
    const files = applied([
      { op: 'remove_record', path: JOURNAL, select: { line: 1 } },
      { op: 'insert_record', path: JOURNAL, record: event('dispatch_started', 'e5', 'j', 99) },
      { op: 'insert_record', path: JOURNAL, record: 'not a record' },
      { op: 'insert_record', path: JOURNAL, record: { source: 'x' } },
      {
        op: 'insert_record',
        path: JOURNAL,
        record: JSON.parse('{"__proto__":1,"source":"s","source_instance_id":"k","source_sequence":7}') as JsonValue,
      },
      { op: 'resequence', path: JOURNAL },
    ]);
    const records = lines(files, JOURNAL);
    assert.deepEqual(
      records.map((record) => (record as { source_sequence?: number }).source_sequence),
      [1, 1, 2, undefined, undefined, 1],
    );
    assert.equal(Object.hasOwn(records[5] as object, '__proto__'), true);
  });

  it('puts a new file and expands the alias inside its values and link targets', () => {
    const files = applied([
      {
        op: 'put_file',
        path: '$trial/extra.json',
        content: { kind: 'json', record: { d: '@sha256($trial/inputs/payment.json)', p: '$trial/x' } },
      },
      { op: 'put_file', path: '$trial/extra.jsonl', content: { kind: 'jsonl', records: ['$trial/y'] } },
      { op: 'insert_record', path: JOURNAL, record: { link: '@md5($trial/inputs/payment.json)' } },
      { op: 'clone_record', path: JOURNAL, select: { line: 1 }, set: [{ pointer: '/to', value: '$trial/z' }] },
      { op: 'set', path: PAYMENT, pointer: '/where', value: ['$trial/w'] },
    ]);
    assert.deepEqual(files.get(`${SUBJECT}/extra.json`), {
      kind: 'json',
      record: { d: '@sha256(trials/t/inputs/payment.json)', p: 'trials/t/x' },
    });
    assert.deepEqual(files.get(`${SUBJECT}/extra.jsonl`), { kind: 'jsonl', records: ['trials/t/y'] });
    assert.deepEqual(lines(files, JOURNAL).at(-1), { link: '@md5(trials/t/inputs/payment.json)' });
    assert.equal((lines(files, JOURNAL)[1] as { to: string }).to, 'trials/t/z');
  });

  it('a model edit of a linked file moves every digest that names it', () => {
    const files = applied([{ op: 'set', path: PAYMENT, pointer: '/amount_minor', value: 1 }]);
    const bytes = serializeScenarioFiles(files);
    assert.ok(bytes.ok);
    const payment = bytes.value.get(PAYMENT) ?? new Uint8Array();
    const manifest = decoder.decode(bytes.value.get(`${SUBJECT}/trial-manifest.json`));
    assert.equal(manifest, `{"payment_sha256":"${createHash('sha256').update(payment).digest('hex')}"}\n`);
  });

  it('reports the failing operation with its position and stops', () => {
    assert.equal(
      failure([{ op: 'resequence', path: 'trials/../x.jsonl' }]).startsWith(
        'operation 1 (resequence): path "trials/../x.jsonl" is ',
      ),
      true,
    );
    assert.equal(
      failure([
        { op: 'resequence', path: JOURNAL },
        { op: 'resequence', path: '$trial/none.jsonl' },
      ]),
      'operation 2 (resequence): the scenario holds no file "trials/t/none.jsonl"; expected an existing fixture file',
    );
    assert.equal(
      failure([{ op: 'set', path: PAYMENT, select: { line: 1 }, pointer: '/a', value: 1 }]),
      'operation 1 (set): a JSON file holds one record; expected no select',
    );
    assert.equal(
      failure([{ op: 'set', path: JOURNAL, pointer: '/a', value: 1 }]),
      'operation 1 (set): a JSONL file holds many records; expected a select naming one',
    );
    assert.equal(
      failure([{ op: 'resequence', path: PAYMENT }]),
      'operation 1 (resequence): the operation edits JSONL lines; expected a .jsonl file',
    );
    assert.match(
      failure([{ op: 'remove', path: PAYMENT, pointer: '/none' }]),
      /^operation 1 \(remove\): pointer "\/none" names no existing member/,
    );
    assert.match(
      failure([{ op: 'set', path: JOURNAL, select: { line: 9 }, pointer: '/a', value: 1 }]),
      /^operation 1 \(set\): no record matches selector/,
    );
    assert.match(
      failure([{ op: 'set', path: JOURNAL, select: { line: 1 }, pointer: '/a/b', value: 1 }]),
      /has no member "a"/,
    );
    assert.match(failure([{ op: 'remove_record', path: JOURNAL, select: { line: 9 } }]), /no record matches/);
    assert.match(failure([{ op: 'insert_record', path: JOURNAL, record: 1, after: { line: 9 } }]), /no record matches/);
    assert.match(failure([{ op: 'clone_record', path: JOURNAL, select: { line: 9 }, set: [] }]), /no record matches/);
    assert.match(
      failure([
        {
          op: 'clone_record',
          path: JOURNAL,
          select: { line: 1 },
          set: [
            { pointer: '/a/b', value: 1 },
            { pointer: '/c', value: 1 },
          ],
        },
      ]),
      /^operation 1 \(clone_record\): pointer "\/a\/b" has no member "a"/,
    );
    assert.match(
      failure([{ op: 'clone_record', path: JOURNAL, select: { line: 1 }, set: [{ pointer: '/a/b', value: 1 }] }]),
      /has no member "a"/,
    );
    assert.match(
      failure([{ op: 'put_file', path: '/abs.json', content: { kind: 'json', record: 1 } }]),
      /^operation 1 \(put_file\): path "\/abs\.json" is /,
    );
  });
});

describe('byte operations', () => {
  const BYTES = new Map([
    [PAYMENT, encoder.encode('{"a":1}\n')],
    [JOURNAL, encoder.encode('{"b":2}\n')],
  ]);

  function bytesAfter(operations: readonly ByteOperation[]): ReadonlyMap<string, string> {
    const result = applyByteOperations(BYTES, operations, SUBJECT);
    assert.ok(result.ok, result.ok ? '' : result.error);
    return new Map([...result.value].map(([path, bytes]) => [path, decoder.decode(bytes)]));
  }

  function byteFailure(operations: readonly ByteOperation[]): string {
    const result = applyByteOperations(BYTES, operations, SUBJECT);
    return result.ok ? '<applied>' : result.error;
  }

  it('deletes, corrupts, appends and truncates on a copy', () => {
    const files = bytesAfter([
      { op: 'delete_file', path: '$trial/inputs/payment.json' },
      { op: 'append_text', path: '$trial/journals/caller-journal.jsonl', text: '{"partial":' },
      { op: 'corrupt_byte', path: JOURNAL, offset: 1, byte: 0x5a },
    ]);
    assert.equal(files.has(PAYMENT), false);
    assert.equal(files.get(JOURNAL), '{Zb":2}\n{"partial":');
    assert.equal(BYTES.has(PAYMENT), true, 'the input is unchanged');
    assert.equal(bytesAfter([{ op: 'truncate', path: PAYMENT, length: 3 }]).get(PAYMENT), '{"a');
    assert.equal(bytesAfter([{ op: 'truncate', path: PAYMENT, length: 8 }]).get(PAYMENT), '{"a":1}\n');
    assert.equal(bytesAfter([{ op: 'truncate', path: PAYMENT, length: 0 }]).get(PAYMENT), '');
    const invalid = applyByteOperations(BYTES, [{ op: 'corrupt_byte', path: PAYMENT, offset: 7, byte: 0xff }], SUBJECT);
    assert.deepEqual(invalid.ok && [...(invalid.value.get(PAYMENT) ?? [])].at(-1), 0xff);
  });

  it('reports out-of-range offsets, bytes and lengths, absent files and bad paths', () => {
    assert.equal(
      byteFailure([{ op: 'corrupt_byte', path: PAYMENT, offset: 8, byte: 0 }]),
      'byte operation 1 (corrupt_byte): offset 8; expected an integer in 0..7',
    );
    assert.equal(
      byteFailure([{ op: 'corrupt_byte', path: PAYMENT, offset: -1, byte: 0 }]),
      'byte operation 1 (corrupt_byte): offset -1; expected an integer in 0..7',
    );
    assert.equal(
      byteFailure([{ op: 'corrupt_byte', path: PAYMENT, offset: 0, byte: 256 }]),
      'byte operation 1 (corrupt_byte): byte 256; expected an integer in 0..255',
    );
    assert.equal(
      byteFailure([{ op: 'corrupt_byte', path: PAYMENT, offset: 0, byte: 0.5 }]),
      'byte operation 1 (corrupt_byte): byte 0.5; expected an integer in 0..255',
    );
    assert.equal(
      byteFailure([{ op: 'truncate', path: PAYMENT, length: 9 }]),
      'byte operation 1 (truncate): length 9; expected an integer in 0..8',
    );
    assert.equal(
      byteFailure([
        { op: 'delete_file', path: PAYMENT },
        { op: 'delete_file', path: PAYMENT },
      ]),
      'byte operation 2 (delete_file): the scenario holds no file "trials/t/inputs/payment.json"; expected an existing fixture file',
    );
    assert.match(
      byteFailure([{ op: 'append_text', path: 'a//b', text: '' }]),
      /^byte operation 1 \(append_text\): path "a\/\/b" is .*; expected a normalized package-relative path$/,
    );
  });
});

describe('materializeCase', () => {
  const base = { ac_ids: [], rule_outcomes_reached: [], base: 'probe', expected: null } as const;

  it('applies model operations before serialization and byte operations after, whatever their order', () => {
    const fixture = materializeCase(
      defineGoldenCase({
        ...base,
        case_id: 'ordering',
        operations: [
          { op: 'corrupt_byte', path: '$trial/inputs/payment.json', offset: 0, byte: 0x20 },
          { op: 'set', path: '$trial/inputs/payment.json', pointer: '/amount_minor', value: 1 },
        ],
      }),
    );
    assert.ok(fixture.ok);
    const payment = decoder.decode(fixture.value.get('probe/inputs/payment.json'));
    assert.match(payment, /^ "amount_minor":1,/);
  });

  it('reports plan, model, link and byte problems', () => {
    const plan = { deliveries: [], processing: 'completes' } as const;
    assert.deepEqual(materializeCase(defineGoldenCase({ ...base, case_id: 'p', plan })), {
      ok: false,
      error: ['case.plan: the probe plan has 0 invocations; expected exactly 1 (BR-RUA-027)'],
    });
    const model = materializeCase(
      defineGoldenCase({ ...base, case_id: 'm', operations: [{ op: 'resequence', path: 'none.jsonl' }] }),
    );
    assert.deepEqual(model, {
      ok: false,
      error: ['operation 1 (resequence): the scenario holds no file "none.jsonl"; expected an existing fixture file'],
    });
    const link = materializeCase(
      defineGoldenCase({
        ...base,
        case_id: 'l',
        operations: [{ op: 'put_file', path: 'x.json', content: { kind: 'json', record: '@sha256(none.json)' } }],
      }),
    );
    assert.deepEqual(link, {
      ok: false,
      error: ['a digest link names "none.json", which the scenario does not hold; expected a fixture file path'],
    });
    const bytes = materializeCase(
      defineGoldenCase({ ...base, case_id: 'b', operations: [{ op: 'truncate', path: 'none.json', length: 0 }] }),
    );
    assert.deepEqual(bytes, {
      ok: false,
      error: ['byte operation 1 (truncate): the scenario holds no file "none.json"; expected an existing fixture file'],
    });
  });
});
