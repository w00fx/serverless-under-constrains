// BR-RUA-033 event envelope: schema version, record type, event id, the one execution identity
// with its manifest digest, both trial fields or neither, occurred_at, source, instance and
// sequence, and causation sorted, unique and omitted for a causal root.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { EventEnvelopeInput } from '../../../src/event-journal/journal-event.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  CAUSE_HIGH,
  CAUSE_LOW,
  dispatchStartedBody,
  EPOCH_UTC,
  executionLevelScope,
  INSTANCE_ID,
  MANIFEST_SHA,
  PROBE,
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_SCOPE,
  VALIDATION,
  VALIDATION_ID,
} from '../../support/event-journal/journal-fixtures.ts';

const EVENT_ID = 'ffffffff-0000-4000-8000-000000000001' as Uuid4;

function envelopeInput(overrides: Partial<EventEnvelopeInput> = {}): EventEnvelopeInput {
  return {
    scope: TRIAL_SCOPE,
    source: 'conventional_caller',
    source_instance_id: INSTANCE_ID,
    source_sequence: 3,
    event_id: EVENT_ID,
    occurred_at: EPOCH_UTC,
    causation: [],
    ...overrides,
  };
}

describe('buildJournalEvent', () => {
  it('writes the full envelope of a trial-scoped causal root', () => {
    assert.deepEqual(buildJournalEvent('dispatch_started', dispatchStartedBody(), envelopeInput()), {
      ...dispatchStartedBody(),
      schema_version: 1,
      record_type: 'dispatch_started',
      event_id: EVENT_ID,
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      trial_id: TRIAL_ID,
      trial_manifest_sha256: TRIAL_MANIFEST_SHA,
      occurred_at: EPOCH_UTC,
      source: 'conventional_caller',
      source_instance_id: INSTANCE_ID,
      source_sequence: 3,
    });
  });

  it('omits both trial fields outside a trial partition and names the execution kind field', () => {
    const probeEvent = buildJournalEvent(
      'dispatch_started',
      dispatchStartedBody(),
      envelopeInput({ scope: executionLevelScope(PROBE, 'probe'), source: 'probe_caller' }),
    );
    assert.equal(probeEvent.transport_probe_id, PROBE_ID);
    assert.equal('trial_id' in probeEvent, false);
    assert.equal('trial_manifest_sha256' in probeEvent, false);
    assert.equal('run_id' in probeEvent, false);
    const validationEvent = buildJournalEvent(
      'controller_canary_acknowledged',
      { canary_event_id: CAUSE_LOW },
      envelopeInput({ scope: executionLevelScope(VALIDATION, 'canary'), source: 'treatment_controller' }),
    );
    assert.equal(validationEvent.variant_validation_id, VALIDATION_ID);
    assert.equal('transport_probe_id' in validationEvent, false);
  });

  it('sorts and deduplicates causation, and omits it for a causal root', () => {
    const caused = buildJournalEvent(
      'dispatch_started',
      dispatchStartedBody(),
      envelopeInput({ causation: [CAUSE_HIGH, CAUSE_LOW, CAUSE_HIGH] }),
    );
    assert.deepEqual(caused.causation_event_ids, [CAUSE_LOW, CAUSE_HIGH]);
    const root = buildJournalEvent('dispatch_started', dispatchStartedBody(), envelopeInput());
    assert.equal('causation_event_ids' in root, false);
  });

  it('never lets a body override an envelope field', () => {
    const smuggled = { ...dispatchStartedBody(), source_sequence: 99, record_type: 'payment', run_id: EVENT_ID };
    const event = buildJournalEvent('dispatch_started', smuggled, envelopeInput());
    assert.equal(event.source_sequence, 3);
    assert.equal(event.record_type, 'dispatch_started');
    assert.equal(event.run_id, RUN_ID);
  });

  it('refuses a sequence outside 1..999999999999', () => {
    for (const invalid of [0, 1.5, 1_000_000_000_000]) {
      assert.throws(
        () => buildJournalEvent('dispatch_started', dispatchStartedBody(), envelopeInput({ source_sequence: invalid })),
        {
          name: 'RangeError',
          message: `source_sequence ${String(invalid)} for dispatch_started; expected a positive integer of at most 12 digits`,
        },
      );
    }
  });
});
