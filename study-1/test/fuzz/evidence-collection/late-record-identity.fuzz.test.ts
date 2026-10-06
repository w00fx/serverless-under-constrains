// Design §12.5 for the late-record identity diff (BR-RUA-043; design §8.13, §10.4 step 1; A-05):
// over arbitrary frozen and re-read records drawn from a small identity space (so ids collide,
// repeat and change content), the late records are exactly the re-read records whose identity the
// frozen copy lacks, each once, in read order; a frozen record re-read unchanged is never late;
// adding the late records to the frozen copy leaves nothing late. Frozen copies read back the
// identities they were written with, in both the JSONL and the document encodings. Over arbitrary
// bytes and values (deep nesting, inherited members, non-JSON values) nothing throws.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  absentItems,
  DOCUMENT_ITEM_MEMBERS,
  documentItems,
  frozenIdentities,
  itemIdentity,
  LATE_ITEM_KINDS,
} from '../../../src/evidence-collection/late-record-identity.ts';
import type { DocumentItemKind, LateItemKind } from '../../../src/evidence-collection/late-record-identity.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const DOCUMENT_KINDS: readonly DocumentItemKind[] = ['ledger_transaction', 'dlq_message', 'durable_execution'];
const IDENTITY_MEMBER: Readonly<Record<DocumentItemKind, string>> = {
  ledger_transaction: 'provider_transaction_id',
  dlq_message: 'message_id',
  durable_execution: 'durable_execution_arn',
};

const smallText = fc.constantFrom('a', 'b', 'c');
const extraContent = fc.dictionary(
  fc.constantFrom('note', 'status', 'count'),
  fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>,
  {
    maxKeys: 2,
  },
);

function journalEvent(): fc.Arbitrary<JsonObject> {
  return fc
    .record({
      event_id: smallText,
      source: fc.constantFrom('caller', 'provider'),
      source_instance_id: smallText,
      source_sequence: fc.integer({ min: 1, max: 3 }),
      extra: extraContent,
    })
    .map(({ extra, ...identity }) => ({ ...extra, ...identity }));
}

function documentItem(kind: DocumentItemKind): fc.Arbitrary<JsonObject> {
  return fc
    .record({ id: fc.option(smallText, { nil: undefined }), extra: extraContent })
    .map(({ id, extra }) => (id === undefined ? extra : { ...extra, [IDENTITY_MEMBER[kind]]: id }));
}

function itemOf(kind: LateItemKind): fc.Arbitrary<JsonObject> {
  return kind === 'journal_event' ? journalEvent() : documentItem(kind);
}

// The frozen copy as the collector writes it: JSONL for a journal, one document otherwise.
function frozenBytes(kind: LateItemKind, items: readonly JsonValue[]): Uint8Array {
  const text =
    kind === 'journal_event'
      ? items.map((item) => `${JSON.stringify(item)}\n`).join('')
      : JSON.stringify({ schema_version: 1, [DOCUMENT_ITEM_MEMBERS[kind]]: items });
  return new TextEncoder().encode(text);
}

const diffCase = fc.constantFrom(...LATE_ITEM_KINDS).chain((kind) =>
  fc.record({
    kind: fc.constant(kind),
    frozen: fc.array(itemOf(kind), { maxLength: 8 }),
    reread: fc.array(itemOf(kind), { maxLength: 12 }),
  }),
);

describe('late-record identity diff', () => {
  it('keeps exactly the re-read records the frozen copy lacks, each once, in read order', () => {
    fc.assert(
      fc.property(diffCase, ({ kind, frozen, reread }) => {
        const known = frozenIdentities(kind, frozenBytes(kind, frozen));
        assert.ok(known.ok);
        const late = absentItems(kind, known.value, [...frozen, ...reread]);
        const expected: JsonObject[] = [];
        const seen = new Set(frozen.map((item) => itemIdentity(kind, item)));
        for (const item of reread) {
          const key = itemIdentity(kind, item);
          if (!seen.has(key)) {
            seen.add(key);
            expected.push(item);
          }
        }
        assert.deepEqual(late, expected);
        const extended = frozenIdentities(kind, frozenBytes(kind, [...frozen, ...late]));
        assert.ok(extended.ok);
        assert.deepEqual(absentItems(kind, extended.value, reread), []);
      }),
      fuzzParameters(),
    );
  });

  it('reads back from a frozen copy exactly the identities it was written with', () => {
    fc.assert(
      fc.property(diffCase, ({ kind, frozen }) => {
        const known = frozenIdentities(kind, frozenBytes(kind, frozen));
        assert.deepEqual(known, { ok: true, value: new Set(frozen.map((item) => itemIdentity(kind, item))) });
        if (kind !== 'journal_event') {
          assert.deepEqual(documentItems(kind, { [DOCUMENT_ITEM_MEMBERS[kind]]: frozen }), frozen);
        }
      }),
      fuzzParameters(),
    );
  });

  it('identifies a keyed record by its identity members only, and a keyless one by its whole content', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DOCUMENT_KINDS),
        smallText,
        extraContent,
        extraContent,
        (kind, id, first, second) => {
          const member = IDENTITY_MEMBER[kind];
          assert.equal(itemIdentity(kind, { ...first, [member]: id }), itemIdentity(kind, { ...second, [member]: id }));
          const reordered = Object.fromEntries(Object.entries(first).reverse());
          assert.equal(itemIdentity(kind, first), itemIdentity(kind, reordered));
          assert.notEqual(itemIdentity(kind, first), itemIdentity(kind, { ...first, [member]: id }));
        },
      ),
      fuzzParameters(),
    );
  });
});

describe('late-record identity totality (A-05)', () => {
  const inherited = fc
    .record({ member: fc.constantFrom('event_id', 'message_id', 'transactions', 'messages'), value: fc.jsonValue() })
    .map(({ member, value }) => Object.create({ [member]: value }) as object);

  it('never throws on arbitrary frozen bytes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LATE_ITEM_KINDS),
        fc.oneof(
          fc.uint8Array({ maxLength: 64 }),
          fc.jsonValue({ maxDepth: 3 }).map((value) => new TextEncoder().encode(JSON.stringify(value))),
          fc.string().map((text) => new TextEncoder().encode(text)),
        ),
        (kind, bytes) => {
          const known = frozenIdentities(kind, bytes);
          assert.ok(known.ok ? known.value instanceof Set : typeof known.error === 'string');
        },
      ),
      fuzzParameters(),
    );
  });

  it('gives every value one string identity, and documents a list only from an own array member', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LATE_ITEM_KINDS),
        fc.oneof(fc.anything({ maxDepth: 3 }), inherited),
        (kind, value) => {
          assert.equal(typeof itemIdentity(kind, value), 'string');
          assert.equal(itemIdentity(kind, value), itemIdentity(kind, value));
          if (kind === 'journal_event') {
            return;
          }
          const list = (value as Record<string, unknown> | null)?.[DOCUMENT_ITEM_MEMBERS[kind]];
          const owned =
            typeof value === 'object' && value !== null && Object.hasOwn(value, DOCUMENT_ITEM_MEMBERS[kind]);
          assert.deepEqual(documentItems(kind, value), owned && Array.isArray(list) ? list : []);
        },
      ),
      fuzzParameters(),
    );
  });
});
