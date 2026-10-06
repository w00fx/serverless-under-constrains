// Design §12.5 for the settlement sample builder (design §5.3, §8.12; BR-RUA-032): over arbitrary
// readings of every unit kind, the built sample is a valid `settlement_sample` record, its
// watermark counts every journal event, processing is terminal exactly when the caller finished
// or a correlated DLQ message was captured (the probe: when its invocation returned), and the
// quiet judgement the evaluator makes of it never sees an unreadable queue as quiet.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { buildSettlementSample, settlementSampleRecord } from '../../../src/evidence-collection/settlement-sample.ts';
import type { SampleUnitReadings, SettlementSampleInput } from '../../../src/evidence-collection/settlement-sample.ts';
import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { TREATMENT_STATES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { quietViolations } from '../../../src/settlement/settlement-activity.ts';
import { assertValidRecord, PROBE_SCOPE, TRIAL_SCOPE } from '../../support/evidence-collection/collection-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const counters = fc.oneof(
  fc.record({ visible: fc.nat(5), in_flight: fc.nat(5), delayed: fc.nat(5) }),
  fc.constant('unavailable' as const),
);
const messageIds = fc.uniqueArray(fc.constantFrom('m1', 'm2', 'm3', 'm4'), { maxLength: 4 });
const queues = fc
  .record({ source_queue: counters, dlq: counters, correlated: messageIds, others: messageIds })
  .map(({ source_queue, dlq, correlated, others }) => ({
    source_queue,
    dlq,
    correlated_dlq_message_ids: correlated,
    dlq_captured_message_ids: [...new Set([...correlated, ...others])],
  }));
const scenario = fc.constantFrom('CONTROL', 'COMMIT_THEN_TIMEOUT');

const unit: fc.Arbitrary<SampleUnitReadings> = fc.oneof(
  fc.record({ kind: fc.constant('conventional' as const), scenario, queues }),
  fc.record({ kind: fc.constant('durable' as const), scenario, queues, inner_executions_terminal: fc.boolean() }),
  fc.record({ kind: fc.constant('probe' as const), invocation_returned: fc.boolean() }),
);

const callerEvent = fc.record({
  record_type: fc.constantFrom('request_state_recorded', 'attempt_started'),
  processing_state: fc.constantFrom('RUNNING', 'FINISHED', 'WAITING'),
});
const providerEvent = fc.record({
  record_type: fc.constantFrom('provider_call_received', 'provider_response_returned'),
  provider_call_id: fc.constantFrom('c1', 'c2'),
});

const sampleInput: fc.Arbitrary<SettlementSampleInput> = fc.record({
  observed_at: fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) })
    .map((ms) => new Date(ms).toISOString() as UtcMillis),
  phase: fc.constantFrom('observation', 'pre_freeze_recheck'),
  publication_stopped: fc.boolean(),
  unit,
  journals: fc.record({
    caller: fc.array(callerEvent, { maxLength: 6 }),
    provider: fc.array(providerEvent, { maxLength: 6 }),
    controller: fc.array(fc.constant({ record_type: 'timeout_signal_recorded' }), { maxLength: 3 }),
  }),
  treatment: fc.option(
    fc.record({ state: fc.constantFrom(...TREATMENT_STATES), version: fc.integer({ min: 1, max: 9 }) }),
    {
      nil: undefined,
    },
  ),
  ledger: fc.record({ complete: fc.boolean(), item_count: fc.nat(10) }),
});

function callerFinished(events: readonly JsonObject[]): boolean {
  return events.some(
    (event) => event['record_type'] === 'request_state_recorded' && event['processing_state'] === 'FINISHED',
  );
}

describe('buildSettlementSample', () => {
  it('builds a valid record whose terminal flags and watermark follow the readings', () => {
    fc.assert(
      fc.property(sampleInput, (input) => {
        const sample = buildSettlementSample(input);
        assertValidRecord(settlementSampleRecord(sample, input.unit.kind === 'probe' ? PROBE_SCOPE : TRIAL_SCOPE));
        const { journals } = input;
        assert.equal(
          sample.correlated_event_watermark,
          journals.caller.length + journals.provider.length + journals.controller.length,
        );
        const expectedTerminal =
          input.unit.kind === 'probe'
            ? input.unit.invocation_returned
            : callerFinished(journals.caller) || input.unit.queues.correlated_dlq_message_ids.length > 0;
        assert.equal(sample.processing_terminal, expectedTerminal);
        assert.equal(sample.ledger_snapshot_possible, input.ledger.complete);
        if (sample.source_queue === 'unavailable' || sample.dlq === 'unavailable') {
          assert.ok(quietViolations(sample).includes('QUEUE_UNAVAILABLE'));
        }
      }),
      fuzzParameters(),
    );
  });
});
