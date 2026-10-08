// One settlement sample from one round of reads (design §5.3, §8.7, §8.12; BR-RUA-032, RK-08): the
// pure mapping from readings to the fields the evaluator judges, and the record a sample is
// written as.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSettlementSample, settlementSampleRecord } from '../../../src/evidence-collection/settlement-sample.ts';
import type { QueueSampleReadings, SettlementSampleInput } from '../../../src/evidence-collection/settlement-sample.ts';
import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { activityCauses } from '../../../src/settlement/settlement-activity.ts';
import { assertValidRecord, PROBE_SCOPE, TRIAL_SCOPE } from '../../support/evidence-collection/collection-fixtures.ts';

const QUIET_QUEUES: QueueSampleReadings = {
  source_queue: { visible: 0, in_flight: 0, delayed: 0 },
  dlq: { visible: 0, in_flight: 0, delayed: 0 },
  correlated_dlq_message_ids: [],
  dlq_captured_message_ids: [],
};

const FINISHED: JsonObject = { record_type: 'request_state_recorded', processing_state: 'FINISHED' };
const RUNNING: JsonObject = { record_type: 'request_state_recorded', processing_state: 'RUNNING' };

function input(overrides: Partial<SettlementSampleInput> = {}): SettlementSampleInput {
  return {
    observed_at: '2026-10-05T12:07:35.000Z' as UtcMillis,
    phase: 'observation',
    publication_stopped: true,
    unit: { kind: 'conventional', scenario: 'CONTROL', queues: QUIET_QUEUES },
    journals: { caller: [RUNNING, FINISHED], provider: [], controller: [] },
    treatment: undefined,
    ledger: { complete: true, item_count: 1 },
    ...overrides,
  };
}

describe('buildSettlementSample', () => {
  it('builds a quiet sample from a finished conventional CONTROL trial', () => {
    const sample = buildSettlementSample(input());
    assert.deepEqual(sample, {
      observed_at: '2026-10-05T12:07:35.000Z',
      phase: 'observation',
      publication_stopped: true,
      processing_terminal: true,
      inner_executions_terminal: 'not_applicable',
      provider_active_calls: 0,
      provider_held_barriers: 0,
      provider_pending_releases: 0,
      treatment_terminal: 'not_applicable',
      ledger_snapshot_possible: true,
      source_queue: { visible: 0, in_flight: 0, delayed: 0 },
      dlq: { visible: 0, in_flight: 0, delayed: 0 },
      correlated_dlq_message_ids: [],
      dlq_captured_message_ids: [],
      correlated_event_watermark: 2,
      ledger_item_count: 1,
    });
    assert.deepEqual(activityCauses(sample, undefined), []);
  });

  it('is not terminal until a request state is FINISHED or a correlated DLQ message is captured (§8.7 (b), RK-08)', () => {
    assert.equal(
      buildSettlementSample(input({ journals: { caller: [RUNNING], provider: [], controller: [] } }))
        .processing_terminal,
      false,
    );
    const redriven = { ...QUIET_QUEUES, correlated_dlq_message_ids: ['m1'], dlq_captured_message_ids: ['m1'] };
    const sample = buildSettlementSample(
      input({
        unit: { kind: 'conventional', scenario: 'CONTROL', queues: redriven },
        journals: { caller: [RUNNING], provider: [], controller: [] },
      }),
    );
    assert.equal(sample.processing_terminal, true);
    assert.deepEqual(sample.correlated_dlq_message_ids, ['m1']);
    assert.equal(
      buildSettlementSample(
        input({ journals: { caller: [{ processing_state: 'FINISHED' }], provider: [], controller: [] } }),
      ).processing_terminal,
      false,
    );
  });

  it('judges the treatment of a treatment trial and of the probe by its state', () => {
    const treated = {
      kind: 'durable',
      scenario: 'COMMIT_THEN_TIMEOUT',
      queues: QUIET_QUEUES,
      inner_executions_terminal: true,
    } as const;
    for (const [state, terminal] of [
      ['COMMITTED_WAITING', false],
      ['RESPONSE_RELEASED', true],
      ['SAFETY_RELEASED', true],
    ] as const) {
      assert.equal(
        buildSettlementSample(input({ unit: treated, treatment: { state, version: 3 } })).treatment_terminal,
        terminal,
      );
    }
    assert.equal(
      buildSettlementSample(input({ unit: treated })).treatment_terminal,
      false,
      'a treatment trial without its item',
    );
    assert.equal(
      buildSettlementSample(input({ unit: treated, treatment: { state: { toString: 'x' } } })).treatment_terminal,
      false,
    );
    assert.equal(buildSettlementSample(input({ unit: treated })).inner_executions_terminal, true);
  });

  it('marks the probe queues not applicable and uses its invocation for processing', () => {
    const probe = buildSettlementSample(
      input({
        unit: { kind: 'probe', invocation_returned: false },
        treatment: { state: 'RESPONSE_RELEASED', version: 5 },
      }),
    );
    assert.deepEqual(
      [
        probe.source_queue,
        probe.dlq,
        probe.processing_terminal,
        probe.treatment_terminal,
        probe.inner_executions_terminal,
      ],
      ['not_applicable', 'not_applicable', false, true, 'not_applicable'],
    );
    assert.equal(
      buildSettlementSample(input({ unit: { kind: 'probe', invocation_returned: true } })).processing_terminal,
      true,
    );
  });

  it('carries provider activity, unavailable counters, an incomplete ledger and the journal watermark', () => {
    const sample = buildSettlementSample(
      input({
        unit: {
          kind: 'conventional',
          scenario: 'COMMIT_THEN_TIMEOUT',
          queues: { ...QUIET_QUEUES, source_queue: 'unavailable' },
        },
        journals: {
          caller: [FINISHED],
          provider: [{ record_type: 'provider_call_received', provider_call_id: 'c1' }],
          controller: [{ record_type: 'timeout_signal_recorded' }],
        },
        treatment: { state: 'TIMEOUT_OBSERVED', version: 4 },
        ledger: { complete: false, item_count: 0 },
      }),
    );
    assert.deepEqual(
      [
        sample.provider_active_calls,
        sample.provider_pending_releases,
        sample.source_queue,
        sample.ledger_snapshot_possible,
        sample.correlated_event_watermark,
      ],
      [1, 1, 'unavailable', false, 3],
    );
    assert.deepEqual(activityCauses(sample, undefined), [
      'LEDGER_ACTIVITY',
      'PROVIDER_ACTIVE',
      'TREATMENT_NOT_TERMINAL',
      'QUEUE_UNAVAILABLE',
    ]);
  });
});

describe('settlementSampleRecord', () => {
  it('writes a valid settlement_sample for a trial and for the probe', () => {
    const trial = settlementSampleRecord(buildSettlementSample(input()), TRIAL_SCOPE);
    assertValidRecord(trial, 'trial settlement_sample');
    const unavailable = buildSettlementSample(
      input({ unit: { kind: 'conventional', scenario: 'CONTROL', queues: { ...QUIET_QUEUES, dlq: 'unavailable' } } }),
    );
    assertValidRecord(settlementSampleRecord(unavailable, TRIAL_SCOPE), 'unavailable dlq');
    const probe = settlementSampleRecord(
      buildSettlementSample(input({ unit: { kind: 'probe', invocation_returned: true } })),
      PROBE_SCOPE,
    );
    assertValidRecord(probe, 'probe settlement_sample');
    assert.equal(probe['source_queue'], 'not_applicable');
  });
});
