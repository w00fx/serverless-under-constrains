// Property target `ControlTableBarrierRelease.requestSafetyRelease` over arbitrary treatment items
// (BR-RUA-025, BR-RUA-048 step 5, Owner amendment A-05 policy 3). The control-table item is
// untrusted store content, so for any `state` and `version` members the release must return a
// value, never throw, and agree with a reference model written from the rule text: a BR-RUA-025
// state with an integer version >= 1 is released when nonterminal and not held when terminal;
// anything else fails, and only a release ever writes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { BarrierReleaseOutcome } from '../../../src/cleanup/cleanup-ports.ts';
import { ControlTableBarrierRelease, TREATMENT_ITEM_SORT_KEY } from '../../../src/cleanup/control-barrier-release.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  NONTERMINAL_TREATMENT_STATES,
  TREATMENT_STATES,
} from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { VerbatimReadItemStore } from '../../support/cleanup/verbatim-read-item-store.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const PARTITION = 'aaaaaaaa-0000-4000-8000-000000000001#bbbbbbbb-0000-4000-8000-000000000001';

const stateMember: fc.Arbitrary<JsonValue | undefined> = fc.oneof(
  fc.constantFrom(...TREATMENT_STATES),
  fc.constantFrom('constructor', 'toString', '__proto__', 'armed', ''),
  fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>,
  fc.constant(undefined),
);

const versionMember: fc.Arbitrary<JsonValue | undefined> = fc.oneof(
  fc.integer({ min: -3, max: 1_000 }),
  fc.double(),
  fc.constantFrom(Number.MAX_SAFE_INTEGER, 2 ** 53, -0),
  fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
  fc.constant(undefined),
);

interface ExpectedRelease {
  readonly kind: BarrierReleaseOutcome['kind'];
  readonly writes: number;
}

// The reference model, from BR-RUA-025 and the `treatment_item` contract (version integer >= 1).
// A release from the largest safe version is attempted, but the store refuses the increment past
// it (DynamoDB numbers the adapter cannot carry exactly, `unencodableNumberReason`), so it fails.
function expectedRelease(state: JsonValue | undefined, version: JsonValue | undefined): ExpectedRelease {
  const knownState = typeof state === 'string' && (TREATMENT_STATES as readonly string[]).includes(state);
  const validVersion = typeof version === 'number' && Number.isSafeInteger(version) && version >= 1;
  if (!knownState || !validVersion) {
    return { kind: 'failed', writes: 0 };
  }
  if (!(NONTERMINAL_TREATMENT_STATES as readonly string[]).includes(state)) {
    return { kind: 'not_held', writes: 0 };
  }
  return version === Number.MAX_SAFE_INTEGER ? { kind: 'failed', writes: 1 } : { kind: 'released', writes: 1 };
}

function itemWith(state: JsonValue | undefined, version: JsonValue | undefined): StoredItem {
  const item: Record<string, JsonValue> = { pk: PARTITION, sk: TREATMENT_ITEM_SORT_KEY };
  if (state !== undefined) {
    item['state'] = state;
  }
  if (version !== undefined) {
    item['version'] = version;
  }
  return item as StoredItem;
}

describe('ControlTableBarrierRelease properties', () => {
  it('returns the reference outcome for any treatment item and writes only to release', async () => {
    await fc.assert(
      fc.asyncProperty(stateMember, versionMember, async (state, version) => {
        const item = itemWith(state, version);
        const { store } = storeHarness();
        store.seed('control', item);
        const observed = new VerbatimReadItemStore(store, item);
        const outcome = await new ControlTableBarrierRelease(observed).requestSafetyRelease(PARTITION);
        const expected = expectedRelease(state, version);
        assert.equal(outcome.kind, expected.kind);
        assert.equal(observed.writeCount(), expected.writes);
        if (outcome.kind === 'failed') {
          assert.equal(outcome.reason.code, 'SAFETY_RELEASE_FAILED');
          assert.ok(
            outcome.reason.detail.length < 1_000,
            `detail of ${String(outcome.reason.detail.length)} characters`,
          );
        }
      }),
      fuzzParameters(),
    );
  });
});
