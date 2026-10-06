// The body of `lease_event_recorded` (catalogue group B row 55; BR-RUA-033, BR-RUA-045): the
// owner always; version, health and last confirmation only with a session state; a holder only
// as a pair and only when another owner holds the item; a detail only when non-empty, cut to
// the bound because it may quote store values (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LEASE_EVENT_DETAIL_LIMIT, leaseEventBody } from '../../../src/coordination-lease/lease-event-body.ts';
import type { LeaseHealthState } from '../../../src/coordination-lease/lease-health.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  OTHER_MANIFEST_SHA,
  RUN_ID,
  RUN_MANIFEST_SHA,
  RUN_OWNER,
  leaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';

const STATE: LeaseHealthState = {
  health: 'UNCERTAIN',
  lease_version: 6,
  last_confirmed_ns: 1n,
  last_confirmed_at: EPOCH_UTC,
};

describe('leaseEventBody', () => {
  it('carries only the event and the owner before any ownership', () => {
    assert.deepEqual(leaseEventBody({ lease_event: 'ACQUISITION_FAILED', owner: RUN_OWNER }), {
      lease_event: 'ACQUISITION_FAILED',
      owner_kind: 'RUN',
      owner_id: RUN_ID,
      owner_manifest_sha256: RUN_MANIFEST_SHA,
    });
  });

  it('adds version, health and last confirmation from the session state', () => {
    assert.deepEqual(
      leaseEventBody({ lease_event: 'HEARTBEAT_FAILED', owner: RUN_OWNER, state: STATE, detail: 'why' }),
      {
        lease_event: 'HEARTBEAT_FAILED',
        owner_kind: 'RUN',
        owner_id: RUN_ID,
        owner_manifest_sha256: RUN_MANIFEST_SHA,
        lease_version: 6,
        lease_health: 'UNCERTAIN',
        last_confirmed_at: EPOCH_UTC,
        detail: 'why',
      },
    );
  });

  it('names another owner as the holder pair', () => {
    const body = leaseEventBody({
      lease_event: 'LOST_OWNERSHIP_MISMATCH',
      owner: RUN_OWNER,
      observed: leaseItem(FOREIGN_OWNER, EPOCH_UTC),
    });
    assert.equal(body.holder_owner_kind, 'TRANSPORT_PROBE');
    assert.equal(body.holder_owner_id, FOREIGN_OWNER.owner_id);
  });

  it('names the same owner id under another manifest as a holder too', () => {
    const body = leaseEventBody({
      lease_event: 'LOST_OWNERSHIP_MISMATCH',
      owner: RUN_OWNER,
      observed: leaseItem({ ...RUN_OWNER, owner_manifest_sha256: OTHER_MANIFEST_SHA }, EPOCH_UTC),
    });
    assert.equal(body.holder_owner_kind, 'RUN');
    assert.equal(body.holder_owner_id, RUN_ID);
  });

  it('never names this owner as a holder', () => {
    const body = leaseEventBody({
      lease_event: 'RELEASED',
      owner: RUN_OWNER,
      observed: leaseItem(RUN_OWNER, EPOCH_UTC),
    });
    assert.equal(Object.hasOwn(body, 'holder_owner_kind'), false);
    assert.equal(Object.hasOwn(body, 'holder_owner_id'), false);
  });

  it('omits an empty detail', () => {
    assert.equal(
      Object.hasOwn(leaseEventBody({ lease_event: 'ACQUIRED', owner: RUN_OWNER, detail: '' }), 'detail'),
      false,
    );
  });

  it('cuts a long detail to the bound', () => {
    const body = leaseEventBody({ lease_event: 'ACQUIRED', owner: RUN_OWNER, detail: 'd'.repeat(5_000) });
    assert.equal(LEASE_EVENT_DETAIL_LIMIT, 400);
    assert.equal(body.detail, `${'d'.repeat(400)}…[truncated]`);
    const exact = leaseEventBody({ lease_event: 'ACQUIRED', owner: RUN_OWNER, detail: 'e'.repeat(400) });
    assert.equal(exact.detail, 'e'.repeat(400));
  });
});
