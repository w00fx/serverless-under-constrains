// State-machine properties of the lease health (testing rule 6: protocol/state-machine
// transitions; BR-RUA-045). For arbitrary sequences of heartbeat observations on a monotonic
// time line, `nextLeaseHealth` matches a reference model written from the rule text:
// - losses are absorbing;
// - at or past 300 s since the last confirmation every observation loses (LOST_STALE);
// - otherwise a confirmation confirms, a failure is uncertainty, a mismatch is a loss, and the
//   clock alone changes nothing.
// Alongside: publication is never allowed unless confirmed and younger than the boundary, the
// next heartbeat is never due after the boundary while uncertain, and the final status of any
// event history is the status of its last settling event, or unverified without one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { LeaseHealthState, LeaseObservation } from '../../../src/coordination-lease/lease-health.ts';
import {
  deriveFinalLeaseStatus,
  heartbeatDelayMs,
  isPublicationAllowed,
  nextLeaseHealth,
} from '../../../src/coordination-lease/lease-health.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { LeaseEvent, LeaseHealth } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const BOUNDARY_NS = 300_000_000_000n;
const AT = '2026-10-05T12:00:00.000Z' as UtcMillis;

type StepKind = 'confirmed' | 'failed' | 'mismatch' | 'clock';

interface Step {
  readonly kind: StepKind;
  /** Nanoseconds since the previous observation. */
  readonly gap_ns: bigint;
  /** Fraction of the gap after which a confirmed write was issued. */
  readonly issue_at: number;
  readonly adopted?: number;
}

const step: fc.Arbitrary<Step> = fc.record(
  {
    kind: fc.constantFrom<StepKind>('confirmed', 'failed', 'mismatch', 'clock'),
    gap_ns: fc.oneof(
      fc.bigInt({ min: 0n, max: 400_000_000_000n }),
      fc.constantFrom(0n, 1n, 30_000_000_000n, BOUNDARY_NS - 1n, BOUNDARY_NS),
    ),
    issue_at: fc.double({ min: 0, max: 1, noNaN: true }),
    adopted: fc.integer({ min: 1, max: 1_000 }),
  },
  { requiredKeys: ['kind', 'gap_ns', 'issue_at'] },
);

const START: LeaseHealthState = { health: 'CONFIRMED', lease_version: 1, last_confirmed_ns: 0n, last_confirmed_at: AT };

function observationOf(item: Step, previousNs: bigint, nowNs: bigint, version: number): LeaseObservation {
  switch (item.kind) {
    case 'confirmed': {
      const issued = previousNs + BigInt(Math.floor(Number(nowNs - previousNs) * item.issue_at));
      return { kind: 'confirmed', issued_ns: issued, observed_ns: nowNs, at: AT, lease_version: version + 1 };
    }
    case 'failed':
      return item.adopted === undefined
        ? { kind: 'failed', observed_ns: nowNs }
        : { kind: 'failed', observed_ns: nowNs, adopted_version: item.adopted };
    case 'mismatch':
      return { kind: 'mismatch', observed_ns: nowNs, code: 'LEASE_OWNERSHIP_MISMATCH' };
    case 'clock':
      return { kind: 'clock', observed_ns: nowNs };
  }
}

// The reference model of BR-RUA-045, written from the rule text.
function modelHealth(previous: LeaseHealth, lastConfirmedNs: bigint, observation: LeaseObservation): LeaseHealth {
  if (previous === 'LOST_STALE' || previous === 'LOST_OWNERSHIP_MISMATCH') {
    return previous;
  }
  if (observation.observed_ns - lastConfirmedNs >= BOUNDARY_NS) {
    return 'LOST_STALE';
  }
  const byKind: Readonly<Record<StepKind, LeaseHealth>> = {
    confirmed: 'CONFIRMED',
    failed: 'UNCERTAIN',
    mismatch: 'LOST_OWNERSHIP_MISMATCH',
    clock: previous,
  };
  return byKind[observation.kind];
}

describe('lease health properties', () => {
  it('follows the BR-RUA-045 reference model over any observation sequence', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        let state = START;
        let nowNs = 0n;
        for (const item of steps) {
          const previousNs = nowNs;
          nowNs += item.gap_ns;
          const observation = observationOf(item, previousNs, nowNs, state.lease_version);
          const next = nextLeaseHealth(state, observation);
          assert.equal(next.health, modelHealth(state.health, state.last_confirmed_ns, observation));
          assert.ok(next.last_confirmed_ns <= nowNs, 'a confirmation never counts from the future');
          if (next.health !== 'CONFIRMED') {
            assert.equal(next.last_confirmed_ns, state.last_confirmed_ns, 'only a confirmation moves the boundary');
          }
          state = next;
        }
      }),
      fuzzParameters(),
    );
  });

  it('never allows publication unless confirmed and younger than the boundary', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LeaseHealth>('CONFIRMED', 'UNCERTAIN', 'LOST_OWNERSHIP_MISMATCH', 'LOST_STALE'),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 600_000_000_000n }),
        (health, lastNs, elapsedNs) => {
          const state: LeaseHealthState = { ...START, health, last_confirmed_ns: lastNs };
          assert.equal(
            isPublicationAllowed(state, lastNs + elapsedNs),
            health === 'CONFIRMED' && elapsedNs < BOUNDARY_NS,
          );
        },
      ),
      fuzzParameters(),
    );
  });

  it('never schedules an uncertain heartbeat after the boundary, nor later than 30 s', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LeaseHealth>('CONFIRMED', 'UNCERTAIN', 'LOST_OWNERSHIP_MISMATCH', 'LOST_STALE'),
        fc.bigInt({ min: 0n, max: 600_000_000_000n }),
        (health, elapsedNs) => {
          const delay = heartbeatDelayMs({ ...START, health }, elapsedNs);
          assert.ok(Number.isSafeInteger(delay) && delay >= 0 && delay <= 30_000);
          if (health !== 'UNCERTAIN') {
            assert.equal(delay, 30_000);
            return;
          }
          const remainingNs = BOUNDARY_NS - elapsedNs;
          const expected = remainingNs <= 0n ? 0 : Math.min(30_000, Number((remainingNs + 999_999n) / 1_000_000n));
          assert.equal(delay, expected, 'due at the boundary (rounded up to a whole millisecond) at the latest');
        },
      ),
      fuzzParameters(),
    );
  });

  it('settles an event history by its last settling event, else unverified', () => {
    const events: readonly LeaseEvent[] = [
      'ACQUIRED',
      'ACQUISITION_FAILED',
      'HEARTBEAT_CONFIRMED',
      'HEARTBEAT_FAILED',
      'RECOVERED',
      'LOST_OWNERSHIP_MISMATCH',
      'LOST_STALE',
      'RELEASED',
      'RELEASE_FAILED',
      'RECOVERY_REQUIRED',
      'STATE_UNVERIFIED',
    ];
    const settled: Readonly<Partial<Record<LeaseEvent, string>>> = {
      RELEASED: 'released',
      RECOVERY_REQUIRED: 'recovery_required',
      RELEASE_FAILED: 'unverified',
      STATE_UNVERIFIED: 'unverified',
    };
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 30 }), (history) => {
        const last = history.findLast((event) => settled[event] !== undefined);
        assert.equal(deriveFinalLeaseStatus(history), last === undefined ? 'unverified' : settled[last]);
      }),
      fuzzParameters(),
    );
  });
});
