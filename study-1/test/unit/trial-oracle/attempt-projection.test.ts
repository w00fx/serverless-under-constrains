// The derived attempt projection (design §8.9, BR-RUA-037, AC-RUA-003): attempts with their
// invocation, outcome, call, transaction and knowledge; every received call; every ledger
// transaction by reference; every Durable execution.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionIdentityFields } from '../../../src/record-contract/envelope.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { AttemptProjection } from '../../../src/record-contract/records/group-c/attempt_projection.ts';
import type { ConventionalInvocationStarted } from '../../../src/record-contract/records/group-b/caller_invocation_started.ts';
import { readAttempts } from '../../../src/trial-oracle/attempt-facts.ts';
import type { AttemptFacts } from '../../../src/trial-oracle/attempt-facts.ts';
import { buildAttemptProjection, invocationOf } from '../../../src/trial-oracle/attempt-projection.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { UNIT_CHECKED_AT } from './support/evaluated-trials.ts';
import { CALLER_JOURNAL, notDispatched } from './support/trial-edits.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT, DURABLE_TREATMENT, edited } from './support/trial-plans.ts';

const RUN_ID = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4' as Uuid4;
const IDENTITY = {
  execution: { run_id: RUN_ID } as ExecutionIdentityFields,
  execution_manifest_sha256: 'c'.repeat(64) as Sha256Hex,
  trial_id: '1549b47d-5c04-4f8c-98f1-789a4dc2eda2' as Uuid4,
  trial_manifest_sha256: 'd'.repeat(64) as Sha256Hex,
};

function project(build: TrialBuild): AttemptProjection {
  const evidence = builtEvidence(build);
  return buildAttemptProjection(evidence, readAttempts(evidence), IDENTITY, UNIT_CHECKED_AT);
}

function firstAttempt(build: TrialBuild): AttemptFacts {
  const [attempt] = readAttempts(builtEvidence(build));
  assert.ok(attempt !== undefined);
  return attempt;
}

describe('buildAttemptProjection', () => {
  it('projects a CONTROL trial: one attempt, one accepted call, one transaction by reference', () => {
    const projection = project(CONVENTIONAL_CONTROL);
    assert.equal(projection.record_type, 'attempt_projection');
    assert.equal('run_id' in projection ? projection.run_id : undefined, RUN_ID);
    assert.equal(projection.trial_id, IDENTITY.trial_id);
    assert.equal(projection.derived_at, UNIT_CHECKED_AT);
    const [attempt] = projection.attempts;
    assert.equal(attempt?.outcome, 'SUCCEEDED');
    assert.equal(attempt.knowledge_after_derived, 'ONE_EFFECT_CONFIRMED');
    assert.equal(attempt.knowledge_after_recorded, 'ONE_EFFECT_CONFIRMED');
    assert.equal(attempt.provider_transaction_id, projection.transactions[0]?.provider_transaction_id);
    assert.equal(attempt.provider_call_id, projection.provider_calls[0]?.provider_call_id);
    assert.equal(attempt.late_transport_settlement, undefined);
    assert.deepEqual(
      projection.provider_calls.map((call) => call.disposition),
      ['ACCEPTED'],
    );
    assert.equal(projection.transactions[0]?.ledger_ref.json_pointer, '/transactions/0');
    assert.deepEqual(projection.durable_executions, []);
  });

  it('keeps both calls in the order received and joins each transaction through its commit', () => {
    const projection = project(CONVENTIONAL_TREATMENT);
    assert.deepEqual(
      projection.provider_calls.map((call) => (call.disposition === 'ACCEPTED' ? call.attempt_id : null)),
      projection.attempts.map((attempt) => attempt.attempt_id),
    );
    assert.equal(projection.transactions.length, 2);
    const [timedOut] = projection.attempts;
    assert.equal(timedOut?.outcome, 'TIMED_OUT');
    assert.equal(timedOut.knowledge_after_derived, 'UNKNOWN');
    assert.ok(
      timedOut.provider_call_id !== undefined,
      'the call comes from the acceptance when the outcome names none',
    );
    assert.ok(timedOut.provider_transaction_id !== undefined);
    assert.equal(timedOut.invocation.receive_count, 1);
    assert.equal(projection.attempts[1]?.invocation.receive_count, 2);
  });

  it('projects Durable invocations with their execution and step, and every Durable execution', () => {
    const projection = project(DURABLE_TREATMENT);
    assert.deepEqual(
      projection.attempts.map((attempt) => attempt.invocation.step_attempt),
      [1, 2],
    );
    assert.ok(projection.attempts.every((attempt) => attempt.invocation.durable_execution_arn !== undefined));
    assert.equal(projection.durable_executions.length, 1);
    assert.ok(projection.attempts[0]?.late_transport_settlement !== undefined);
  });

  it('omits a Durable step attempt the invocation does not record', () => {
    const projection = project(
      edited(DURABLE_TREATMENT, [
        {
          op: 'remove',
          path: CALLER_JOURNAL,
          select: { record_type: 'caller_invocation_started' },
          pointer: '/step_attempt',
        },
      ]),
    );
    assert.equal(projection.attempts[0]?.invocation.step_attempt, undefined);
    assert.ok(projection.attempts[0]?.invocation.durable_execution_arn !== undefined);
  });

  it('lists a rejected call with its reason', () => {
    const projection = project({
      base: 'run-durable-treatment',
      plan: {
        deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'rejected' }] }],
        processing: 'completes',
      },
    });
    assert.deepEqual(
      projection.provider_calls.map((call) => call.disposition),
      ['ACCEPTED', 'REJECTED'],
    );
    const rejected = projection.provider_calls[1];
    assert.ok(rejected?.disposition === 'REJECTED');
    assert.equal(rejected.rejection_reason, 'PAYMENT_NOT_FOUND');
    assert.equal(projection.attempts[1]?.provider_transaction_id, undefined);
  });

  it('lists a received call never accepted or rejected as unresolved', () => {
    const projection = project(
      edited(CONVENTIONAL_CONTROL, [
        {
          op: 'remove_record',
          path: '$trial/journals/provider-journal.jsonl',
          select: { record_type: 'provider_call_accepted' },
        },
        { op: 'resequence', path: '$trial/journals/provider-journal.jsonl' },
      ]),
    );
    assert.deepEqual(
      projection.provider_calls.map((call) => call.disposition),
      ['UNRESOLVED'],
    );
  });

  it('projects no transaction without a ledger snapshot and no recorded knowledge without a request state', () => {
    const projection = project(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'delete_file', path: '$trial/ledger/ledger-snapshot.json' },
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'request_state_recorded' } },
        { op: 'resequence', path: CALLER_JOURNAL },
      ]),
    );
    assert.deepEqual(projection.transactions, []);
    assert.equal(projection.attempts[0]?.knowledge_after_recorded, undefined);
    assert.equal(projection.attempts[0]?.outcome, 'SUCCEEDED');
  });

  it('omits the outcome of an attempt that recorded none, and a call no evidence names', () => {
    const projection = project(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'attempt_outcome_recorded' } },
        { op: 'resequence', path: CALLER_JOURNAL },
        {
          op: 'remove_record',
          path: '$trial/journals/provider-journal.jsonl',
          select: { record_type: 'provider_call_accepted' },
        },
        { op: 'resequence', path: '$trial/journals/provider-journal.jsonl' },
      ]),
    );
    assert.equal(projection.attempts[0]?.outcome, undefined);
    assert.equal(projection.attempts[0]?.outcome_class, 'AMBIGUOUS');
    assert.equal(projection.attempts[0].provider_call_id, undefined);
  });
});

describe('buildAttemptProjection of a contradicted outcome', () => {
  it('lists the attempt as ambiguous without the outcome its dispatch evidence contradicts', () => {
    const projection = project(edited(CONVENTIONAL_CONTROL, notDispatched(1)));
    const [attempt] = projection.attempts;
    assert.equal(attempt?.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(attempt.outcome, undefined);
    assert.equal(attempt.outcome_class, 'AMBIGUOUS');
    assert.equal(attempt.knowledge_after_derived, 'UNKNOWN');
  });
});

describe('invocationOf', () => {
  it('gives a conventional invocation its message and receive count, without Durable members', () => {
    const invocation = invocationOf(firstAttempt(CONVENTIONAL_CONTROL));
    assert.equal(invocation.source, 'conventional_caller');
    assert.equal(invocation.receive_count, 1);
    assert.ok(invocation.message_id !== undefined);
    assert.equal(invocation.durable_execution_arn, undefined);
  });

  it("falls back to the attempt's own source instance when no invocation was recorded", () => {
    const { invocation: _ignored, ...attempt } = firstAttempt(CONVENTIONAL_CONTROL);
    assert.deepEqual(invocationOf(attempt), {
      source: attempt.registered.record.source,
      source_instance_id: attempt.registered.record.source_instance_id,
    });
  });

  it('gives a probe invocation no message, count or execution', () => {
    const attempt = firstAttempt(CONVENTIONAL_CONTROL);
    assert.ok(attempt.invocation !== undefined);
    const {
      message_id: _message,
      approximate_receive_count: _count,
      ...rest
    } = attempt.invocation.record as ConventionalInvocationStarted;
    const probe: AttemptFacts = {
      ...attempt,
      invocation: { ...attempt.invocation, record: { ...rest, source: 'probe_caller' } },
    };
    assert.deepEqual(invocationOf(probe), {
      source: attempt.registered.record.source,
      source_instance_id: attempt.registered.record.source_instance_id,
    });
  });
});
