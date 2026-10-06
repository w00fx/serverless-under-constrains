// The integrity checks a base fixture must pass and a case's fault breaks (BR-RUA-033,
// BR-RUA-034): every check is shown to pass on a sound fixture and to name exactly the problem a
// single model or byte edit introduces.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fixtureIntegrityProblems, parseFixtureRecords } from '../../support/golden-builder/fixture-integrity.ts';
import { materializeCase } from '../../support/golden-builder/fixture-materializer.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import type { BaseScenarioId, TrialPlan } from '../../support/golden-builder/golden-plan.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';

const validator = createRecordValidator();
const encoder = new TextEncoder();

function problems(base: BaseScenarioId, operations: readonly ScenarioOperation[], plan?: TrialPlan): readonly string[] {
  const fixture = materializeCase(
    defineGoldenCase({
      case_id: 'integrity',
      ac_ids: [],
      rule_outcomes_reached: [],
      base,
      expected: null,
      operations,
      ...(plan === undefined ? {} : { plan }),
    }),
  );
  assert.ok(fixture.ok, fixture.ok ? '' : fixture.error.join('\n'));
  return fixtureIntegrityProblems(fixture.value, validator);
}

const CALLER = '$trial/journals/caller-journal.jsonl';
const PROVIDER = '$trial/journals/provider-journal.jsonl';

describe('parseFixtureRecords', () => {
  it('reads records in path order and reports lines that are not objects', () => {
    const parsed = parseFixtureRecords(
      new Map([
        ['b.jsonl', encoder.encode('{"b":1}\n[2]\nnot json\n')],
        ['a.json', encoder.encode('{"a":1}\n')],
        ['c.json', encoder.encode('"text"\n')],
      ]),
    );
    assert.deepEqual(parsed.records, [
      { path: 'a.json', record: { a: 1 } },
      { path: 'b.jsonl', record: { b: 1 } },
    ]);
    assert.deepEqual(parsed.problems, [
      'b.jsonl: a line or document is not a JSON object; expected a record',
      'b.jsonl: a line or document is not a JSON object; expected a record',
      'c.json: a line or document is not a JSON object; expected a record',
    ]);
  });
});

describe('fixtureIntegrityProblems', () => {
  it('finds nothing in sound fixtures of every shape', () => {
    assert.deepEqual(problems('probe', []), []);
    assert.deepEqual(
      problems('run-conventional-treatment', [], {
        deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'commit_failed' }] }],
        processing: 'completes',
      }),
      [],
    );
  });

  it('reports a schema violation', () => {
    const found = problems('probe', [
      { op: 'set', path: CALLER, select: { line: 1 }, pointer: '/schema_version', value: 2 },
    ]);
    assert.equal(found.length, 1);
    assert.match(
      found[0] ?? '',
      /^probe\/journals\/caller-journal\.jsonl: caller_invocation_started violates its schema: /,
    );
  });

  it('reports an unparseable line', () => {
    assert.deepEqual(problems('probe', [{ op: 'append_text', path: CALLER, text: '{"partial":' }]), [
      'probe/journals/caller-journal.jsonl: a line or document is not a JSON object; expected a record',
    ]);
  });

  it('reports a repeated event id and the sequence it breaks', () => {
    const found = problems('probe', [{ op: 'clone_record', path: CALLER, select: { line: 2 }, set: [] }]);
    assert.equal(found.filter((problem) => problem.includes('appears twice; expected unique event ids')).length, 1);
    assert.equal(
      found.filter((problem) => /^probe_caller#[0-9a-f-]+: sequences \[1,2,2,3,4,5,6\]; expected 1\.\.7$/.test(problem))
        .length,
      1,
    );
  });

  it('reports a sequence gap left by a removed event, and none once resequenced', () => {
    const removed: ScenarioOperation = {
      op: 'remove_record',
      path: PROVIDER,
      select: { record_type: 'provider_commit_confirmed' },
    };
    const found = problems('probe', [removed]);
    assert.ok(
      found.some((problem) => /^refund_provider#[0-9a-f-]+: sequences \[1,2,3,5,6\]; expected 1\.\.5$/.test(problem)),
      found.join('\n'),
    );
    assert.ok(
      problems('probe', [removed, { op: 'resequence', path: PROVIDER }]).every(
        (problem) => !problem.includes('sequences'),
      ),
    );
  });

  it('reports unsorted and unresolved causation', () => {
    const found = problems('probe', [
      {
        op: 'set',
        path: CALLER,
        select: { record_type: 'dispatch_started' },
        pointer: '/causation_event_ids',
        value: ['ffffffff-ffff-4fff-bfff-ffffffffffff', '00000000-0000-4000-8000-000000000000'],
      },
    ]);
    assert.ok(found.some((problem) => problem.endsWith('causation is not sorted and unique')));
    assert.equal(found.filter((problem) => problem.includes('names unresolved predecessor')).length, 2);
  });

  it('reports every digest that no longer names its bytes', () => {
    const fields: readonly (readonly [string, string])[] = [
      ['execution_manifest_sha256', CALLER],
      ['trial_manifest_sha256', '$trial/journals/caller-journal.jsonl'],
      ['resource_manifest_sha256', '$trial/trial-manifest.json'],
      ['payment_sha256', '$trial/trial-manifest.json'],
      ['approved_decision_sha256', '$trial/trial-manifest.json'],
    ];
    for (const [field, path] of fields) {
      const select = path.endsWith('.jsonl') ? { select: { line: 1 } } : {};
      const found = problems('run-conventional-control', [
        { op: 'set', path, ...select, pointer: `/${field}`, value: 'a'.repeat(64) },
      ]);
      assert.ok(
        found.some((problem) => problem.includes(`${field} "${'a'.repeat(64)}"; expected the digest `)),
        `${field}: ${found.join('\n')}`,
      );
    }
  });

  it('reports a core file changed after its digests were taken', () => {
    const found = problems('run-conventional-control', [
      { op: 'append_text', path: '$trial/inputs/payment.json', text: ' ' },
    ]);
    assert.ok(found.length > 0);
    assert.ok(found.every((problem) => problem.includes('trial-manifest.json: payment_sha256')));
  });

  it('reports a published message whose digests do not match its bytes', () => {
    const found = problems('run-conventional-control', [
      { op: 'append_text', path: '$trial/inputs/published-message.json', text: ' ' },
    ]);
    assert.deepEqual(found, [
      'runner/runner-journal.jsonl: trial_message_published digests do not match the published message bytes',
    ]);
  });

  it('reports a DLQ message whose body digests do not match its body', () => {
    const plan: TrialPlan = {
      deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'commit_failed' }] }],
      processing: 'completes',
    };
    const found = problems(
      'run-conventional-treatment',
      [{ op: 'set', path: '$trial/queues/dlq-snapshot.json', pointer: '/messages/0/body', value: 'tampered' }],
      plan,
    );
    assert.deepEqual(
      found.filter((problem) => problem.includes('body digests')),
      [`${dlqPath(found)}: messages[0] body digests do not match its body bytes`],
    );
  });
});

function dlqPath(found: readonly string[]): string {
  const problem = found.find((text) => text.includes('body digests')) ?? '';
  return problem.slice(0, problem.indexOf(':'));
}
