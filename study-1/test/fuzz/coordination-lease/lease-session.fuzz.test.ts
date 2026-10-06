// State-machine property of LeaseSession against the coordination-store emulation (testing
// rule 6; BR-RUA-045, AC-RUA-023, AC-RUA-033). For arbitrary sequences of heartbeat outcomes
// (applied, rejected, ambiguous with or without effect and with or without a readable item, a
// foreign takeover, a TTL-style deletion) at arbitrary gaps, and either closure:
// - publication is allowed exactly while the last beat confirmed ownership inside the boundary;
// - a loss, once established, never changes, and no heartbeat is written after it;
// - a loss is established exactly when a mismatch was seen or the boundary passed;
// - every journal line is a valid `lease_event_recorded` record;
// - `released` is final only when the store shows this owner's item released, and
//   `recovery_required` only when it shows this owner's item recovery required.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseEvents,
  leaseHarness,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

type BeatScript =
  | 'applied'
  | 'rejected'
  | 'ambiguous_landed'
  | 'ambiguous_lost'
  | 'ambiguous_landed_unread'
  | 'ambiguous_lost_unread'
  | 'takeover'
  | 'ttl_delete';

interface Beat {
  readonly script: BeatScript;
  readonly gap_ms: number;
}

const beat: fc.Arbitrary<Beat> = fc.record({
  script: fc.constantFrom<BeatScript>(
    'applied',
    'rejected',
    'ambiguous_landed',
    'ambiguous_lost',
    'ambiguous_landed_unread',
    'ambiguous_lost_unread',
    'takeover',
    'ttl_delete',
  ),
  gap_ms: fc.oneof(fc.integer({ min: 0, max: 200_000 }), fc.constantFrom(30_000, 299_999, 300_000)),
});

const validator = createRecordValidator();
const BOUNDARY_MS = 300_000;

function scriptBeat(lease: LeaseHarness, script: BeatScript): void {
  const scripts: Readonly<Record<BeatScript, () => void>> = {
    applied: () => undefined,
    rejected: () => {
      lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    },
    ambiguous_landed: () => {
      lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    },
    ambiguous_lost: () => {
      lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: false });
    },
    ambiguous_landed_unread: () => {
      lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
      lease.store.failNextReads(1, 'InternalServerError');
    },
    ambiguous_lost_unread: () => {
      lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: false });
      lease.store.failNextReads(1, 'InternalServerError');
    },
    takeover: () => {
      lease.store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 1);
    },
    ttl_delete: () => {
      lease.store.deleteLeaseItemAsTtl();
    },
  };
  scripts[script]();
}

function heartbeatWrites(lease: LeaseHarness): number {
  return lease.log.entries().filter((entry) => entry.operation === 'UpdateItem').length;
}

describe('LeaseSession properties', () => {
  it('keeps the publication gate, the loss and the final status consistent with the store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(beat, { minLength: 1, maxLength: 16 }),
        fc.constantFrom('clean', 'unclean'),
        async (beats, closure) => {
          const lease = leaseHarness();
          await lease.session.acquire(RUN_OWNER);
          let lastConfirmedMs = 0;
          let nowMs = 0;
          for (const { script, gap_ms } of beats) {
            await lease.time.advanceBy(gap_ms);
            nowMs += gap_ms;
            const lostBefore = lease.session.loss();
            const writesBefore = heartbeatWrites(lease);
            if (lostBefore === undefined) {
              scriptBeat(lease, script);
            }
            const health = await lease.session.heartbeatOnce();
            if (lostBefore !== undefined) {
              assert.equal(lease.session.loss(), lostBefore, 'a loss never changes');
              assert.equal(heartbeatWrites(lease), writesBefore, 'no heartbeat is written after a loss');
              continue;
            }
            const stale = nowMs - lastConfirmedMs >= BOUNDARY_MS;
            const refuted = !stale && (script === 'takeover' || script === 'ttl_delete');
            if (health === 'CONFIRMED') {
              lastConfirmedMs = nowMs;
            }
            assert.equal(lease.session.publicationAllowed(), health === 'CONFIRMED');
            assert.equal(health === 'LOST_STALE', stale, `stale after ${String(nowMs - lastConfirmedMs)} ms`);
            assert.equal(health === 'LOST_OWNERSHIP_MISMATCH', refuted);
            assert.equal(lease.session.loss() !== undefined, stale || refuted);
          }
          const status = await lease.session.finalize(closure);
          const item = lease.store.current();
          const ownItem = item?.['owner_id'] === RUN_OWNER.owner_id;
          if (status === 'released') {
            assert.ok(ownItem && item['lease_status'] === 'RELEASED');
          }
          if (status === 'recovery_required') {
            assert.ok(ownItem && item['lease_status'] === 'RECOVERY_REQUIRED');
          }
          if (!ownItem) {
            assert.equal(status, 'unverified');
          }
          for (const event of leaseEvents(lease)) {
            const checked = validator.validateAs('lease_event_recorded', event as unknown as JsonValue);
            assert.ok(checked.valid, JSON.stringify(checked.valid ? [] : checked.violations));
          }
        },
      ),
      fuzzParameters(),
    );
  });
});
