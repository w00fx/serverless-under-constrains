// Late-record identity (BR-RUA-043, BR-RUA-033, BR-RUA-034): which re-read records the frozen
// artifacts already hold. Exact keys per kind, the content fallback for every missing identity
// member, frozen-byte reading, and the A-05 hostile inputs (100,000-level nesting, non-finite
// numbers, inherited member names).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  absentItems,
  documentItems,
  frozenIdentities,
  itemIdentity,
  LATE_ITEM_KINDS,
} from '../../../src/evidence-collection/late-record-identity.ts';
import type { LateItemKind } from '../../../src/evidence-collection/late-record-identity.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';

const encoder = new TextEncoder();
const EVENT = {
  event_id: 'e1',
  source: 'refund_provider',
  source_instance_id: 'i1',
  source_sequence: 3,
  record_type: 'provider_call_accepted',
};

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function known(kind: LateItemKind, text: string): ReadonlySet<string> {
  const identities = frozenIdentities(kind, bytes(text));
  assert.ok(identities.ok, `expected readable frozen bytes: ${text.slice(0, 80)}`);
  return identities.value;
}

describe('itemIdentity', () => {
  it('keys a journal event by its event id and source position', () => {
    assert.equal(itemIdentity('journal_event', EVENT), '["journal_event","e1","refund_provider","i1",3]');
    assert.equal(
      itemIdentity('journal_event', { ...EVENT, record_type: 'other', occurred_at: 'x' }),
      itemIdentity('journal_event', EVENT),
    );
  });

  it('keys an event by its content when any identity member is missing or malformed', () => {
    for (const member of ['event_id', 'source', 'source_instance_id', 'source_sequence'] as const) {
      const { [member]: _dropped, ...partial } = EVENT;
      assert.equal(
        itemIdentity('journal_event', partial),
        `["content",${JSON.stringify(Object.fromEntries(Object.entries(partial).sort()))}]`,
        member,
      );
    }
    assert.match(itemIdentity('journal_event', { ...EVENT, source_sequence: 0 }), /^\["content",/);
    assert.match(itemIdentity('journal_event', { ...EVENT, event_id: '' }), /^\["content",/);
  });

  it('keys each document item by its identity member', () => {
    assert.equal(
      itemIdentity('ledger_transaction', { provider_transaction_id: 't1', amount_minor: 1 }),
      '["ledger_transaction","t1"]',
    );
    assert.equal(itemIdentity('dlq_message', { message_id: 'm1', body: 'b' }), '["dlq_message","m1"]');
    assert.equal(
      itemIdentity('durable_execution', { durable_execution_arn: 'arn:x', status: 'RUNNING' }),
      '["durable_execution","arn:x"]',
    );
    assert.equal(itemIdentity('dlq_message', { message_id: 7 }), '["content",{"message_id":7}]');
    assert.equal(itemIdentity('ledger_transaction', 'not an object'), '["content","not an object"]');
  });

  it('never reads an inherited member as an identity', () => {
    const inherited = Object.create({ provider_transaction_id: 't1' }) as object;
    // A non-plain object has no JSON content either, so it can match nothing frozen.
    assert.equal(itemIdentity('ledger_transaction', inherited), '["unrepresentable"]');
    const parsed = JSON.parse('{"__proto__":{"message_id":"m1"}}') as object;
    assert.equal(itemIdentity('dlq_message', parsed), '["content",{"__proto__":{"message_id":"m1"}}]');
    assert.equal(itemIdentity('journal_event', { constructor: 'x' }), '["content",{"constructor":"x"}]');
  });

  it('gives every unrepresentable item one key instead of throwing', () => {
    const keys = LATE_ITEM_KINDS.map((kind) => itemIdentity(kind, { value: Number.POSITIVE_INFINITY }));
    assert.deepEqual(new Set(keys), new Set(['["unrepresentable"]']));
    assert.equal(itemIdentity('dlq_message', { message_id: 'm', extra: 1n }), '["dlq_message","m"]');
  });
});

describe('frozenIdentities', () => {
  it('reads a frozen journal line by line', () => {
    const text = `${JSON.stringify(EVENT)}\n${JSON.stringify({ ...EVENT, event_id: 'e2' })}\n`;
    assert.deepEqual(
      [...known('journal_event', text)],
      [itemIdentity('journal_event', EVENT), itemIdentity('journal_event', { ...EVENT, event_id: 'e2' })],
    );
    assert.equal(known('journal_event', '').size, 0);
  });

  it('refuses a frozen journal with an unreadable line, naming it', () => {
    assert.deepEqual(frozenIdentities('journal_event', bytes('{"a":1}\n{bad\n')), {
      ok: false,
      error: 'line 2 is not one JSON value (invalid_json)',
    });
    assert.deepEqual(frozenIdentities('journal_event', new Uint8Array([0xff, 0x0a])), {
      ok: false,
      error: 'line 1 is not one JSON value (invalid_utf8)',
    });
  });

  it('reads the item list of a frozen document', () => {
    const ledger = { transactions: [{ provider_transaction_id: 't1' }, { provider_transaction_id: 't2' }] };
    assert.equal(known('ledger_transaction', JSON.stringify(ledger)).size, 2);
    assert.equal(known('dlq_message', '{"messages":[{"message_id":"m"}]}').has('["dlq_message","m"]'), true);
    assert.equal(
      known('durable_execution', '{"executions":[{"durable_execution_arn":"a"}]}').has('["durable_execution","a"]'),
      true,
    );
  });

  it('refuses a frozen document that is not JSON or has no item list', () => {
    assert.deepEqual(frozenIdentities('ledger_transaction', bytes('{"transactions":')), {
      ok: false,
      error: 'is not one JSON document (invalid_json)',
    });
    assert.deepEqual(frozenIdentities('dlq_message', bytes('{"messages":{}}')), {
      ok: false,
      error: 'holds no messages list',
    });
    assert.deepEqual(frozenIdentities('durable_execution', bytes('[]')), {
      ok: false,
      error: 'holds no executions list',
    });
  });

  it('refuses a non-finite number and an inherited list name, and survives 100,000-level nesting', () => {
    assert.deepEqual(frozenIdentities('ledger_transaction', bytes('{"transactions":[{"amount_minor":1e400}]}')), {
      ok: false,
      error: 'is not one JSON document (invalid_json)',
    });
    assert.deepEqual(frozenIdentities('dlq_message', bytes('{"__proto__":{"messages":[]}}')), {
      ok: false,
      error: 'holds no messages list',
    });
    const deepItem = towerText('mixed', DEEP_NESTING, '1');
    assert.equal(known('ledger_transaction', `{"transactions":[${deepItem}]}`).size, 1);
    assert.equal(known('journal_event', `${towerText('object', DEEP_NESTING, 'null')}\n`).size, 1);
  });
});

describe('absentItems', () => {
  it('keeps each item whose identity is not known, once, in read order', () => {
    const frozen = new Set([itemIdentity('dlq_message', { message_id: 'm1' })]);
    const items = [
      { message_id: 'm2', receive: 1 },
      { message_id: 'm1', receive: 5 },
      { message_id: 'm2', receive: 2 },
      { message_id: 'm3' },
    ];
    assert.deepEqual(absentItems('dlq_message', frozen, items), [
      { message_id: 'm2', receive: 1 },
      { message_id: 'm3' },
    ]);
    assert.equal(frozen.size, 1);
  });

  it('keeps an event that reuses a known id at another position (a conflict stays visible)', () => {
    const frozen = new Set([itemIdentity('journal_event', EVENT)]);
    const moved = { ...EVENT, source_sequence: 4 };
    assert.deepEqual(absentItems('journal_event', frozen, [EVENT, moved]), [moved]);
  });
});

describe('documentItems', () => {
  it('reads the own item list of a document and nothing else', () => {
    assert.deepEqual(documentItems('ledger_transaction', { transactions: [1] }), [1]);
    assert.deepEqual(documentItems('dlq_message', { messages: 'x' }), []);
    assert.deepEqual(documentItems('durable_execution', null), []);
    assert.deepEqual(documentItems('durable_execution', Object.create({ executions: [1] })), []);
  });
});
