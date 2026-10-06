// The golden scenario builder (design §12.4) over alternate subject plans. Every built scenario
// must be primary evidence a real execution could leave: schema-valid, internally consistent
// (BR-RUA-033, BR-RUA-034), its runner assessment equal to the §8.12 derivation from its own
// samples, and its subject trial showing what the spec says the plan produces — provider
// rejection, a definitive commit failure, a safety release, an uncontrolled CONTROL timeout,
// retries exhausted into the DLQ, processing active at the deadline, and the probe's attempts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { serializeScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import { fixtureIntegrityProblems } from '../../support/golden-builder/fixture-integrity.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import { BASE_SCENARIO_IDS } from '../../support/golden-builder/golden-plan.ts';
import type { BaseScenarioId, TrialPlan } from '../../support/golden-builder/golden-plan.ts';
import { recordText } from '../../support/golden-builder/golden-event-log.ts';
import { buildBaseScenario, subjectDirectoryOf } from '../../support/golden-builder/scenario-builder.ts';
import { deriveSettlement, observeSubject, runnerEvents } from '../../golden/_harness/fixture-observations.ts';
import { expectedMismatches, fixtureRecords } from '../../golden/_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../golden/_harness/golden-harness.ts';

const validator = createRecordValidator();

function built(base: BaseScenarioId, plan?: TrialPlan): LoadedGoldenCase {
  const scenario = buildBaseScenario(base, plan);
  assert.ok(scenario.ok, scenario.ok ? '' : scenario.error.join('\n'));
  const bytes = serializeScenarioFiles(scenario.value.files);
  assert.ok(bytes.ok, bytes.ok ? '' : bytes.error.join('\n'));
  return {
    golden_case: defineGoldenCase({ case_id: 'unit', ac_ids: [], rule_outcomes_reached: [], base, expected: null }),
    case_file: 'test/golden/unit/cases/unit.case.ts',
    fixture_directory: 'test/golden/unit/fixtures/unit',
    files: bytes.value,
    subject_directory: scenario.value.subject_directory,
  };
}

function subjectRecords(loaded: LoadedGoldenCase, path: string): readonly JsonObject[] {
  return fixtureRecords(loaded.files, `${loaded.subject_directory}/${path}`);
}

// The checks every built scenario passes, whatever its plan.
function assertSound(loaded: LoadedGoldenCase): void {
  assert.deepEqual(fixtureIntegrityProblems(loaded.files, validator), []);
  const assessed = runnerEvents(loaded, 'settlement_assessed').at(-1);
  const samples = subjectRecords(loaded, 'settlement/settlement-samples.jsonl');
  const start =
    runnerEvents(loaded, 'trial_message_published')[0] ?? subjectRecords(loaded, 'journals/caller-journal.jsonl')[0];
  const started = Date.parse(start === undefined ? '' : recordText(start, 'occurred_at'));
  const derived = deriveSettlement(samples, started + 600_000);
  assert.deepEqual(expectedMismatches({ ...derived, sample_count: samples.length }, assessed), []);
}

function assertSubject(loaded: LoadedGoldenCase, expected: JsonObject): void {
  assert.deepEqual(expectedMismatches(expected, observeSubject(loaded)), []);
}

const one = (behavior: string): { readonly attempts: readonly { readonly behavior: never }[] } => ({
  attempts: [{ behavior: behavior as never }],
});

describe('scenario builder: bases', () => {
  it('builds every base deterministically, with the subject directory the base names', () => {
    for (const base of BASE_SCENARIO_IDS) {
      const first = buildBaseScenario(base);
      const second = buildBaseScenario(base);
      assert.ok(first.ok && second.ok);
      const a = serializeScenarioFiles(first.value.files);
      const b = serializeScenarioFiles(second.value.files);
      assert.ok(a.ok && b.ok);
      assert.deepEqual([...a.value.keys()], [...b.value.keys()]);
      assert.ok(
        [...a.value].every(([path, bytes]) => Buffer.from(bytes).equals(b.value.get(path) ?? new Uint8Array())),
      );
      assert.equal(first.value.subject_directory, subjectDirectoryOf(base));
    }
  });

  it('holds the execution prefix up to the subject trial, and one runner instance across it', () => {
    const loaded = built('run-durable-treatment');
    const trialDirectories = new Set(
      [...loaded.files.keys()].filter((path) => path.startsWith('trials/')).map((path) => path.split('/')[1]),
    );
    assert.equal(trialDirectories.size, 4);
    const runner = fixtureRecords(loaded.files, 'runner/runner-journal.jsonl');
    assert.equal(new Set(runner.map((record) => record['source_instance_id'])).size, 1);
    assert.deepEqual(
      runner.map((record) => record['source_sequence']),
      runner.map((_, index) => index + 1),
    );
    assert.deepEqual(
      runner.slice(0, 4).map((record) => [record['phase'], record['status']]),
      [
        ['LEASE_ACQUISITION', 'succeeded'],
        ['PROVISIONING', 'succeeded'],
        ['READINESS', 'succeeded'],
        ['TRIALS', 'started'],
      ],
    );
    assert.equal(
      runner.filter((record) => record['record_type'] === 'treatment_armed').length,
      2,
      'only the two treatments arm',
    );
    assert.equal(built('validation-conventional-control').files.has('provisioning/resource-manifest.json'), true);
  });

  it('builds the probe with no queue and no trial directory', () => {
    const loaded = built('probe');
    assert.equal(loaded.subject_directory, 'probe');
    assert.equal(
      [...loaded.files.keys()].some((path) => path.startsWith('trials/') || path.includes('/queues/')),
      false,
    );
    assert.equal(runnerEvents(loaded, 'probe_workload_invoked').length, 1);
    assertSound(loaded);
  });
});

describe('scenario builder: alternate subject plans', () => {
  it('a provider rejection finishes processing with no transaction', () => {
    const loaded = built('run-conventional-control', { deliveries: [one('rejected')], processing: 'completes' });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 1, provider_calls: 1, successful_transactions: 0 },
      settlement_status: 'established',
      processing_terminal_reason: 'PROVIDER_REJECTED',
    });
    const rejected = subjectRecords(loaded, 'journals/provider-journal.jsonl').find(
      (record) => record['record_type'] === 'provider_call_rejected',
    );
    assert.equal(rejected?.['reason'], 'PAYMENT_NOT_FOUND');
  });

  it('a Durable provider rejection finishes processing inside one step attempt', () => {
    const loaded = built('run-durable-control', {
      deliveries: [{ attempts: [{ behavior: 'rejected', rejection_reason: 'CURRENCY_MISMATCH' }] }],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 1, provider_calls: 1, durable_attempts: 1, successful_transactions: 0 },
      processing_terminal_reason: 'PROVIDER_REJECTED',
    });
  });

  it('a definitive commit failure leaves no transaction and the redelivery succeeds', () => {
    const loaded = built('run-conventional-control', {
      deliveries: [one('commit_failed'), one('succeeded')],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { published_messages: 1, source_deliveries: 2, provider_calls: 2, successful_transactions: 1 },
      treatment_final_state: null,
      processing_terminal_reason: 'SUCCEEDED',
    });
  });

  it('a targeted commit the controller never signals is safety-released', () => {
    const loaded = built('run-conventional-treatment', {
      deliveries: [one('safety_release'), one('succeeded')],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 2, provider_calls: 2, successful_transactions: 2 },
      treatment_final_state: 'SAFETY_RELEASED',
      processing_terminal_reason: 'SUCCEEDED',
    });
  });

  it('an uncontrolled CONTROL timeout commits, is rejected by the controller, and is retried', () => {
    const loaded = built('run-conventional-control', {
      deliveries: [one('untargeted_timeout'), one('succeeded')],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 2, provider_calls: 2, successful_transactions: 2 },
      treatment_final_state: null,
      processing_terminal_reason: 'SUCCEEDED',
    });
    const controller = subjectRecords(loaded, 'journals/controller-journal.jsonl');
    assert.deepEqual(
      controller.map((record) => record['record_type']),
      ['caller_timeout_rejected'],
    );
    assert.equal(controller[0]?.['reason'], 'CONTROL_TRIAL');
  });

  it('a conventional message whose retries are exhausted moves to the DLQ and settles', () => {
    const loaded = built('run-conventional-treatment', {
      deliveries: [one('targeted_timeout'), one('commit_failed')],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 2, provider_calls: 2, successful_transactions: 1 },
      treatment_final_state: 'RESPONSE_RELEASED',
      settlement_status: 'established',
      processing_terminal_reason: 'RETRIES_EXHAUSTED',
    });
    const samples = subjectRecords(loaded, 'settlement/settlement-samples.jsonl');
    assert.equal((samples.at(-1)?.['dlq_captured_message_ids'] as readonly string[]).length, 1);
  });

  // OR-RUA-002: the Durable visibility timeout is 360 s, so the second receive comes 360 s after the
  // first and the message reaches the DLQ only when that receive's visibility expires, 720 s after
  // publication — past the 600 s observation deadline. The source is still in flight at the
  // deadline, so settlement cannot be established although processing finished.
  it('a Durable request exhausts its step retries on both deliveries, after the deadline settles', () => {
    const loaded = built('run-durable-treatment', {
      deliveries: [
        { attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'commit_failed' }] },
        { attempts: [{ behavior: 'commit_failed' }, { behavior: 'commit_failed' }] },
      ],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { source_deliveries: 2, provider_calls: 4, durable_attempts: 4, successful_transactions: 1 },
      processing_terminal_reason: 'RETRIES_EXHAUSTED',
      settlement_status: 'not_established',
    });
    const assessed = runnerEvents(loaded, 'settlement_assessed').at(-1);
    assert.deepEqual(
      (assessed?.['reasons'] as readonly JsonObject[]).map((reason) => reason['code']),
      ['SOURCE_IN_FLIGHT'],
    );
  });

  it('processing still active at the deadline is not established, for either caller', () => {
    const conventional = built('run-conventional-control', {
      deliveries: [one('untargeted_timeout')],
      processing: 'active_at_deadline',
    });
    assertSound(conventional);
    assertSubject(conventional, { settlement_status: 'not_established', processing_terminal_reason: null });
    const durable = built('validation-durable-treatment', {
      deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'commit_failed' }] }],
      processing: 'active_at_deadline',
    });
    assertSound(durable);
    assertSubject(durable, { settlement_status: 'not_established', processing_terminal_reason: null });
    const assessed = runnerEvents(durable, 'settlement_assessed').at(-1);
    assert.ok(Array.isArray(assessed?.['reasons']) && assessed['reasons'].length > 0);
  });

  it('the probe can retry inside its one invocation', () => {
    const loaded = built('probe', {
      deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'succeeded' }] }],
      processing: 'completes',
    });
    assertSound(loaded);
    assertSubject(loaded, {
      configured_trace: { published_messages: 0, source_deliveries: 0, provider_calls: 2, successful_transactions: 2 },
      treatment_final_state: 'RESPONSE_RELEASED',
    });
  });

  it('carries the plan amount, currency and identifiers into the call and the ledger', () => {
    const loaded = built('run-conventional-control', {
      deliveries: [
        {
          attempts: [
            {
              behavior: 'succeeded',
              amount_minor: 2500,
              currency: 'USD',
              refund_request_id: 'ref-x',
              payment_id: 'pay-x',
            },
          ],
        },
      ],
      processing: 'completes',
    });
    assertSound(loaded);
    const [transaction] = (subjectRecords(loaded, 'ledger/ledger-snapshot.json')[0]?.['transactions'] ??
      []) as readonly JsonObject[];
    assert.deepEqual(
      [
        transaction?.['amount_minor'],
        transaction?.['currency'],
        transaction?.['refund_request_id'],
        transaction?.['payment_id'],
      ],
      [2500, 'USD', 'ref-x', 'pay-x'],
    );
  });

  it('refuses a plan the architecture cannot run, with every problem', () => {
    assert.deepEqual(
      buildBaseScenario('run-durable-control', {
        deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, one('succeeded'), one('succeeded')],
        processing: 'completes',
      }),
      {
        ok: false,
        error: [
          'the plan has 3 source deliveries; expected 1 or 2 (maxReceiveCount 2, OR-RUA-002)',
          'attempt 2 is succeeded but attempts follow it; expected it to be the last attempt',
          'attempt 1 (targeted_timeout) is targeted; expected the targeted commit only as the first accepted call of a treatment',
        ],
      },
    );
    assert.deepEqual(
      buildBaseScenario('run-durable-treatment', {
        deliveries: [one('targeted_timeout'), one('succeeded')],
        processing: 'completes',
      }),
      {
        ok: false,
        error: [
          'the first Durable delivery ends before its step retry; expected two step attempts before a redelivery',
        ],
      },
    );
  });
});
