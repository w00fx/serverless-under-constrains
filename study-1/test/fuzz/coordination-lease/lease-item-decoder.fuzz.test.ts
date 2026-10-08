// Property tests of the lease item decoder (testing rule 6: a decoder of untrusted store
// output; A-05 totality, A-07 closed item). Against an independent reference model of the
// layout: every valid item decodes to itself; an item with one member replaced by a hostile
// value decodes exactly when the model accepts that value; an extra member, an inherited name
// among them, is always refused; and decoding any JSON object never throws and explains a
// refusal in a bounded message. Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { decodeLeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  LEASE_MEMBER_NAMES,
  foreignMemberName,
  hostileMemberValue,
  isValidLeaseMember,
  validLeaseItem,
} from '../../support/coordination-lease/lease-arbitraries.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const MAX_DETAIL = 1_000;

function assertBoundedRefusal(item: StoredItem): void {
  const decoded = decodeLeaseItem(item);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, 'LEASE_ITEM_UNDECODABLE');
  assert.ok(decoded.error.detail.length <= MAX_DETAIL, `detail of ${String(decoded.error.detail.length)} characters`);
}

describe('decodeLeaseItem properties', () => {
  it('decodes every valid item to itself', () => {
    fc.assert(
      fc.property(validLeaseItem, (item) => {
        assert.deepEqual(decodeLeaseItem({ ...item }), { ok: true, value: item });
      }),
      fuzzParameters(),
    );
  });

  it('accepts one replaced member exactly when the reference model accepts its value', () => {
    fc.assert(
      fc.property(validLeaseItem, fc.constantFrom(...LEASE_MEMBER_NAMES), hostileMemberValue, (item, member, value) => {
        const replaced = { ...item, [member]: value } as StoredItem;
        const decoded = decodeLeaseItem(replaced);
        assert.equal(decoded.ok, isValidLeaseMember(member, value), `member ${member}`);
        if (!decoded.ok) {
          assert.ok(decoded.error.detail.startsWith(`lease item member ${member} is `), decoded.error.detail);
          assert.ok(decoded.error.detail.length <= MAX_DETAIL);
        }
      }),
      fuzzParameters(),
    );
  });

  it('refuses any extra member, whatever its name or value', () => {
    fc.assert(
      fc.property(validLeaseItem, foreignMemberName, hostileMemberValue, (item, name, value) => {
        const extended: Record<string, JsonValue> = { ...item };
        Object.defineProperty(extended, name, { value, enumerable: true, configurable: true, writable: true });
        assertBoundedRefusal(extended as StoredItem);
      }),
      fuzzParameters(),
    );
  });

  it('refuses an item missing any member', () => {
    fc.assert(
      fc.property(validLeaseItem, fc.constantFrom(...LEASE_MEMBER_NAMES), (item, member) => {
        const partial = Object.fromEntries(Object.entries(item).filter(([name]) => name !== member));
        assertBoundedRefusal(partial as StoredItem);
      }),
      fuzzParameters(),
    );
  });

  it('never throws on any JSON object and refuses it unless it is a whole valid item', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), hostileMemberValue, { maxKeys: 14 }), (object) => {
        const item = { ...object } as StoredItem;
        const decoded = decodeLeaseItem(item);
        const valid =
          Object.keys(item).length === LEASE_MEMBER_NAMES.length &&
          LEASE_MEMBER_NAMES.every(
            (member) => Object.hasOwn(item, member) && isValidLeaseMember(member, item[member] as JsonValue),
          );
        assert.equal(decoded.ok, valid);
        if (!decoded.ok) {
          assert.ok(decoded.error.detail.length <= MAX_DETAIL);
        }
      }),
      fuzzParameters(),
    );
  });
});
