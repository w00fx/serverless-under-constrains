// Design §12.5 for the provider activity derivation (design §9.3; BR-RUA-032): over arbitrary
// journal rows and treatment items, hostile ones included, the counts are bounded — active calls
// at most the distinct call ids named, at most one held barrier or pending release — and a
// terminal event for a call never increases the active count.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  deriveProviderActivity,
  TERMINAL_PROVIDER_EVENTS,
} from '../../../src/evidence-collection/provider-activity.ts';
import { TREATMENT_STATES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const callId = fc.constantFrom('c1', 'c2', 'c3', 'c4');
const recordType = fc.constantFrom('provider_call_received', 'provider_call_accepted', ...TERMINAL_PROVIDER_EVENTS);

const wellFormedEvent = fc.record({ record_type: recordType, provider_call_id: callId });
const hostileEvent = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.record({ record_type: fc.anything({ maxDepth: 1 }), provider_call_id: fc.anything({ maxDepth: 1 }) }),
  fc.constant(Object.create({ record_type: 'provider_call_received', provider_call_id: 'inherited' }) as object),
);
const providerEvent = fc.oneof({ weight: 4, arbitrary: wellFormedEvent }, { weight: 1, arbitrary: hostileEvent });

const treatment = fc.option(
  fc.oneof(
    fc.record({ state: fc.constantFrom(...TREATMENT_STATES) }),
    fc.record({ state: fc.anything({ maxDepth: 1 }) }),
  ),
  { nil: undefined },
);

function callIdOf(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null || !Object.hasOwn(event, 'provider_call_id')) {
    return undefined;
  }
  const id = (event as Readonly<Record<string, unknown>>)['provider_call_id'];
  return typeof id === 'string' ? id : undefined;
}

function namedCallIds(events: readonly unknown[]): number {
  return new Set(events.map(callIdOf).filter((id) => id !== undefined)).size;
}

describe('deriveProviderActivity', () => {
  it('stays within bounds over arbitrary rows, and a terminal event never adds activity', () => {
    fc.assert(
      fc.property(
        fc.array(providerEvent, { maxLength: 20 }),
        treatment,
        callId,
        fc.constantFrom(...TERMINAL_PROVIDER_EVENTS),
        (events, item, closingCall, closingType) => {
          const rows = events as readonly JsonObject[];
          const activity = deriveProviderActivity(rows, item as JsonObject | undefined);
          assert.ok(activity.active_calls >= 0 && activity.active_calls <= namedCallIds(events));
          assert.ok(activity.held_barriers + activity.pending_releases <= 1);
          const closed = deriveProviderActivity(
            [...rows, { record_type: closingType, provider_call_id: closingCall }],
            item as JsonObject | undefined,
          );
          assert.ok(closed.active_calls <= activity.active_calls);
          assert.equal(closed.held_barriers, activity.held_barriers);
        },
      ),
      fuzzParameters(),
    );
  });
});
