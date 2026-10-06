// Design §8.2 step I8 (INV-RUA-001; AC-RUA-017): identities are unique in the execution scope.
// Caller-generated reuse (attempt and provider-request ids) feeds identity integrity;
// provider-generated reuse (call, transaction and commit ids) feeds evidence integrity; a subject
// reference to an unregistered attempt is missing identity evidence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildIdentityRegistry } from '../../../src/evidence-ingestion/identity-registry.ts';
import type { IdentityRegistry, IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { sortEvidenceRefs } from '../../../src/record-contract/evidence-refs.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import { artifactValues, ingest, subjectOf, trialInput } from './support/evidence-fixtures.ts';
import { indexedEvent, uuid } from './support/indexed-events.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const PROVIDER = '$trial/journals/provider-journal.jsonl';
const NEW_EVENT = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';

function registryOf(input: IngestionInput): IdentityRegistry {
  return ingest(input).identities;
}

function kinds(collisions: IdentityRegistry['caller_collisions']): readonly string[] {
  return collisions.map((collision) => collision.kind).toSorted();
}

describe('buildIdentityRegistry over trial evidence', () => {
  it('finds no collision across a run prefix of three trials', () => {
    const registry = registryOf(trialInput('run-conventional-treatment'));
    assert.deepEqual(registry, { caller_collisions: [], provider_collisions: [], unregistered_attempts: [] });
  });

  it('reports an attempt registered by two events', () => {
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'clone_record',
        path: CALLER,
        select: { record_type: 'attempt_registered' },
        set: [{ pointer: '/event_id', value: NEW_EVENT }],
      },
    ];
    const registry = registryOf(trialInput('run-conventional-control', operations));
    assert.deepEqual(kinds(registry.caller_collisions), ['attempt_id', 'provider_request_id']);
    const [collision] = registry.caller_collisions;
    assert.equal(collision?.origin_event_ids.length, 2);
    assert.ok(collision.origin_event_ids.includes(NEW_EVENT));
    assert.equal(collision.partitions.length, 1);
    assert.deepEqual(collision.refs, sortEvidenceRefs(collision.refs));
    assert.deepEqual(registry.provider_collisions, []);
  });

  it('reports a provider_request_id paired with two attempts', () => {
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'set',
        path: PROVIDER,
        select: { record_type: 'provider_call_accepted' },
        pointer: '/attempt_id',
        value: uuid(41),
      },
    ];
    const registry = registryOf(trialInput('run-conventional-control', operations));
    assert.deepEqual(kinds(registry.caller_collisions), ['provider_request_id']);
    assert.deepEqual(
      registry.unregistered_attempts.map((attempt) => attempt.attempt_id),
      [uuid(41)],
    );
    assert.equal(registry.unregistered_attempts[0]?.ref.event_id !== undefined, true);
  });

  it('reports an attempt id that an earlier trial already used', () => {
    const plain = trialInput('run-conventional-treatment');
    const earlier = plain.execution_scope_artifacts.find((artifact) => artifact.path.endsWith('caller-journal.jsonl'));
    const reused = artifactValues(plain, earlier?.path ?? '')
      .map((value) => (value as Record<string, string | undefined>)['attempt_id'])
      .find((id) => id !== undefined);
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'set',
        path: CALLER,
        select: { record_type: 'attempt_registered' },
        pointer: '/attempt_id',
        value: reused ?? '',
      },
    ];
    const registry = registryOf(trialInput('run-conventional-treatment', operations));
    const attempt = registry.caller_collisions.find((collision) => collision.kind === 'attempt_id');
    assert.equal(attempt?.partitions.length, 2);
    assert.ok(attempt.partitions.includes(subjectOf(plain).slice('trials/'.length)));
  });

  it('ignores reuse found only among earlier trials', () => {
    const plain = trialInput('run-conventional-treatment');
    const earlier =
      plain.execution_scope_artifacts.find((artifact) => artifact.path.endsWith('caller-journal.jsonl'))?.path ?? '';
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'clone_record',
        path: earlier,
        select: { record_type: 'attempt_registered' },
        set: [{ pointer: '/event_id', value: NEW_EVENT }],
      },
    ];
    assert.deepEqual(registryOf(trialInput('run-conventional-treatment', operations)).caller_collisions, []);
  });

  it('reports a provider call id created twice as a provider-generated collision', () => {
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'clone_record',
        path: PROVIDER,
        select: { record_type: 'provider_call_received' },
        set: [{ pointer: '/event_id', value: NEW_EVENT }],
      },
    ];
    const registry = registryOf(trialInput('run-conventional-control', operations));
    assert.deepEqual(kinds(registry.provider_collisions), ['provider_call_id']);
    assert.deepEqual(registry.caller_collisions, []);
  });

  it('reports a transaction id on two ledger items as a provider-generated collision', () => {
    const operations: readonly ScenarioOperation[] = [0, 1].map((index) => ({
      op: 'set',
      path: '$trial/ledger/ledger-snapshot.json',
      pointer: `/transactions/${String(index)}/provider_transaction_id`,
      value: uuid(42),
    }));
    const registry = registryOf(trialInput('run-conventional-treatment', operations));
    const [collision] = registry.provider_collisions;
    assert.equal(collision?.kind, 'provider_transaction_id');
    assert.equal(collision.id, uuid(42));
    assert.deepEqual(collision.origin_event_ids, []);
    assert.deepEqual(
      collision.refs.map((ref) => ref.json_pointer),
      ['/transactions/0', '/transactions/1'],
    );
  });

  it('reports subject references to an attempt nobody registered', () => {
    const operations: readonly ScenarioOperation[] = [
      { op: 'remove_record', path: CALLER, select: { record_type: 'attempt_registered' } },
    ];
    const registry = registryOf(trialInput('run-conventional-control', operations));
    assert.deepEqual(
      registry.unregistered_attempts.map((attempt) => attempt.ref.artifact_path.split('/').at(-1)).toSorted(),
      ['caller-journal.jsonl', 'caller-journal.jsonl', 'provider-journal.jsonl', 'provider-journal.jsonl'],
    );
  });
});

describe('buildIdentityRegistry over hand-built events', () => {
  const received = indexedEvent({
    event_id: uuid(1),
    record_type: 'provider_call_received',
    partition: uuid(90),
    members: { provider_call_id: uuid(50) },
  });

  it('does not treat a trial-partition rejection as a second creation of its call id', () => {
    const rejected = indexedEvent({
      event_id: uuid(2),
      record_type: 'provider_call_rejected',
      partition: uuid(90),
      members: { provider_call_id: uuid(50) },
    });
    assert.deepEqual(buildIdentityRegistry([received, rejected], []).provider_collisions, []);
  });

  it('treats an execution-level rejection as creating its call id (A-09)', () => {
    const rejected = indexedEvent({
      event_id: uuid(2),
      record_type: 'provider_call_rejected',
      members: { provider_call_id: uuid(50) },
    });
    const [collision] = buildIdentityRegistry([received, rejected], []).provider_collisions;
    assert.deepEqual(collision?.partitions, ['execution', uuid(90)].toSorted());
    assert.deepEqual(collision.origin_event_ids, [uuid(1), uuid(2)]);
  });

  it('counts a caller timeout as an attempt reference only when a caller recorded it', () => {
    const timeout = (source: string): ReturnType<typeof indexedEvent> =>
      indexedEvent({
        event_id: uuid(3),
        record_type: 'caller_timeout_recorded',
        source,
        members: { attempt_id: uuid(60) },
      });
    assert.deepEqual(buildIdentityRegistry([timeout('runner')], []).unregistered_attempts, []);
    assert.deepEqual(
      buildIdentityRegistry([timeout('conventional_caller')], []).unregistered_attempts.map(
        (attempt) => attempt.attempt_id,
      ),
      [uuid(60)],
    );
  });

  it('does not judge references outside the subject, nor events without the identity', () => {
    const elsewhere = indexedEvent({
      event_id: uuid(4),
      record_type: 'dispatch_started',
      origin: 'supplementary',
      members: { attempt_id: uuid(61) },
    });
    const anonymous = indexedEvent({ event_id: uuid(5), record_type: 'dispatch_started' });
    const unrelated = indexedEvent({ event_id: uuid(6), record_type: 'phase_transition_recorded' });
    assert.deepEqual(buildIdentityRegistry([elsewhere, anonymous, unrelated], []), {
      caller_collisions: [],
      provider_collisions: [],
      unregistered_attempts: [],
    });
  });
});
