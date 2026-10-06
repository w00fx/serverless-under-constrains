// The attribution inputs (design §8.17): checked once, then held in lookup form, with the window
// already widened to whole hours and the ownership tag value taken from the execution identity (D-07).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAttributionContext } from '../../../src/billing-amendment/attribution-context.ts';
import type { AttributionContextInput } from '../../../src/billing-amendment/attribution-context.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { LEDGER_ARN, PROVIDER_ARN, RUN_CONTEXT, RUN_ID } from './support/cur-export-builder.ts';

const EXPECTED_SHAPE =
  'expected a 12-digit account, a UUIDv4 execution id, non-empty trimmed identities and operations, and first_mutation_at <= cleanup_terminal_at as YYYY-MM-DDTHH:mm:ss.SSSZ';

function problems(input: AttributionContextInput): readonly string[] {
  const parsed = parseAttributionContext(input);
  assert.ok(!parsed.ok, JSON.stringify(parsed));
  for (const reason of parsed.error) {
    assert.equal(reason.code, 'INVALID_ATTRIBUTION_CONTEXT');
    assert.equal(reason.subject, 'BR-RUA-047');
    assert.ok(reason.detail.endsWith(`; ${EXPECTED_SHAPE}`), reason.detail);
  }
  return parsed.error.map((reason) => reason.detail.slice(0, -(EXPECTED_SHAPE.length + 2)));
}

describe('parseAttributionContext', () => {
  it('returns the run context in lookup form', () => {
    const parsed = parseAttributionContext(RUN_CONTEXT);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.account_id, '123456789012');
    assert.equal(parsed.value.ownership_tag_value, RUN_ID);
    assert.deepEqual([...parsed.value.resource_identities], [PROVIDER_ARN, LEDGER_ARN]);
    assert.deepEqual(
      [...parsed.value.charge_allowlist].map(([product, operations]) => [product, [...operations]]),
      [
        ['AWSLambda', ['Invoke']],
        ['AmazonDynamoDB', ['PayPerRequestThroughput']],
      ],
    );
    assert.deepEqual(parsed.value.window, { start: '2026-10-05T10:00:00.000Z', end: '2026-10-05T12:00:00.000Z' });
  });

  it('takes the ownership tag value from every execution kind (D-07)', () => {
    const probeId = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081' as Uuid4;
    const validationId = '2c3d4e5f-6071-4829-8b3c-4d5e6f708192' as Uuid4;
    const probe = parseAttributionContext({
      ...RUN_CONTEXT,
      identity: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: probeId },
    });
    const validation = parseAttributionContext({
      ...RUN_CONTEXT,
      identity: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: validationId },
    });
    assert.ok(probe.ok && validation.ok);
    assert.equal(probe.value.ownership_tag_value, probeId);
    assert.equal(validation.value.ownership_tag_value, validationId);
  });

  it('merges allowlist entries of one product', () => {
    const parsed = parseAttributionContext({
      ...RUN_CONTEXT,
      charge_allowlist: [
        { product_code: 'AWSQueueService', operations: ['SendMessage'] },
        { product_code: 'AWSQueueService', operations: ['ReceiveMessage', 'SendMessage'] },
      ],
    });
    assert.ok(parsed.ok);
    assert.deepEqual(
      [...(parsed.value.charge_allowlist.get('AWSQueueService') ?? [])],
      ['SendMessage', 'ReceiveMessage'],
    );
  });

  it('accepts a cleanup at the same instant as the first mutation and at the latest supported hour', () => {
    const same = { ...RUN_CONTEXT, cleanup_terminal_at: RUN_CONTEXT.first_mutation_at };
    assert.equal(parseAttributionContext(same).ok, true);
    const latest = { ...RUN_CONTEXT, cleanup_terminal_at: '9999-12-31T23:00:00.000Z' };
    const parsed = parseAttributionContext(latest);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.window.end, '9999-12-31T23:00:00.000Z');
  });

  it('refuses a malformed account and execution id', () => {
    assert.deepEqual(problems({ ...RUN_CONTEXT, account_id: '12345678901' }), [
      'account_id "12345678901" is not a 12-digit account id',
    ]);
    assert.deepEqual(problems({ ...RUN_CONTEXT, account_id: '1234567890123' }), [
      'account_id "1234567890123" is not a 12-digit account id',
    ]);
    assert.deepEqual(problems({ ...RUN_CONTEXT, identity: { execution_kind: 'RUN', run_id: 'RUN-1' as Uuid4 } }), [
      'execution id "RUN-1" is not a lowercase UUIDv4',
    ]);
  });

  it('refuses empty or edge-whitespace identities and allowlist entries', () => {
    assert.deepEqual(
      problems({
        ...RUN_CONTEXT,
        resource_identities: ['', ' arn'],
        charge_allowlist: [
          { product_code: ' AWSLambda', operations: ['Invoke '] },
          { product_code: 'AmazonSQS', operations: [] },
        ],
      }),
      [
        'resource_identities entry "" is empty or has edge whitespace',
        'resource_identities entry " arn" is empty or has edge whitespace',
        'charge_allowlist product_code " AWSLambda" is empty or has edge whitespace',
        'charge_allowlist operations entry "Invoke " is empty or has edge whitespace',
        'charge_allowlist entry "AmazonSQS" lists no operation',
      ],
    );
  });

  it('refuses unreadable, reversed and out-of-range instants', () => {
    assert.deepEqual(problems({ ...RUN_CONTEXT, first_mutation_at: '2026-10-05T10:17:03Z' }), [
      'first_mutation_at "2026-10-05T10:17:03Z" or cleanup_terminal_at "2026-10-05T11:02:00.000Z" is not a UTC millis timestamp',
    ]);
    assert.deepEqual(problems({ ...RUN_CONTEXT, cleanup_terminal_at: 'soon' }), [
      'first_mutation_at "2026-10-05T10:17:03.120Z" or cleanup_terminal_at "soon" is not a UTC millis timestamp',
    ]);
    assert.deepEqual(problems({ ...RUN_CONTEXT, cleanup_terminal_at: '2026-10-05T10:17:03.119Z' }), [
      'cleanup_terminal_at 2026-10-05T10:17:03.119Z precedes first_mutation_at 2026-10-05T10:17:03.120Z or is past 9999-12-31T23:00:00.000Z',
    ]);
    assert.deepEqual(problems({ ...RUN_CONTEXT, cleanup_terminal_at: '9999-12-31T23:00:00.001Z' }), [
      'cleanup_terminal_at 9999-12-31T23:00:00.001Z precedes first_mutation_at 2026-10-05T10:17:03.120Z or is past 9999-12-31T23:00:00.000Z',
    ]);
  });

  it('reports every problem at once', () => {
    assert.equal(problems({ ...RUN_CONTEXT, account_id: 'x', resource_identities: [''] }).length, 2);
  });

  it('names the first five problems and counts the rest, however long the lists are (A-12)', () => {
    const listed = problems({ ...RUN_CONTEXT, resource_identities: Array.from({ length: 100_000 }, () => '') });
    assert.equal(listed.length, 6);
    assert.equal(listed[0], 'resource_identities entry "" is empty or has edge whitespace');
    assert.equal(listed[5], '99995 more problem(s) not listed');
  });
});
