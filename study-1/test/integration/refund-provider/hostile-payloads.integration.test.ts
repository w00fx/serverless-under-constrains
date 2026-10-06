// Hostile payloads at the provider boundary (BR-RUA-018, AC-RUA-042, testing rules 3 and 6).
// The Lambda Node runtime JSON-parses the Invoke bytes before the handler runs, so each payload
// here is built as text and parsed the same way: `1e400` arrives as Infinity, and nesting is
// limited only by the payload size. WP-07 review round 1 found that such calls threw a raw
// TypeError or RangeError from the request digest and the guards' details, so they were neither
// received nor rejected. Each is now received, judged and rejected with a fresh provider_call_id,
// with no transaction and the treatment left armed. Owner amendment A-05 fixes the regression set
// of this boundary: nesting of at least 100,000 levels, non-finite numbers, and members named like
// Object.prototype members, which JSON.parse makes own properties and which must never be read
// through the prototype chain.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { ProviderHarness } from '../../support/refund-provider/provider-fixtures.ts';
import {
  armedTreatmentItem,
  field,
  ledgerItems,
  MANIFEST_SHA,
  onlyEvent,
  PROBE,
  PROBE_PK,
  providerEventTypes,
  providerHarness,
  RUN_ID,
  seedProbe,
  seedRunTrial,
  treatmentItem,
  TRIAL_PK,
  validCall,
  validProbeCall,
  WARMUP_ID,
} from '../../support/refund-provider/provider-fixtures.ts';
import { expectProviderFault } from './support/fault-assertions.ts';

const DEEP = 100_000;
const DEEP_ARRAY_TEXT = `${'['.repeat(DEEP)}${']'.repeat(DEEP)}`;
const DEEP_OBJECT_TEXT = `${'{"a":'.repeat(DEEP)}1${'}'.repeat(DEEP)}`;
/** The marker the kernel's `boundedJsonText` appends to a cut text. */
const TRUNCATED = '…[truncated]';
// Generous: the detail adds its field name and expected shape to one bounded excerpt.
const DETAIL_BOUND = QUOTED_JSON_LIMIT + 200;
const UTF8 = new TextEncoder();

/** `call` with `member` set to the literal JSON text `literal`, parsed as the runtime parses it. */
function parsedWith(call: JsonObject, member: string, literal: string): JsonObject {
  const rest = Object.fromEntries(Object.entries(call).filter(([key]) => key !== member));
  return JSON.parse(`${JSON.stringify(rest).slice(0, -1)},${JSON.stringify(member)}:${literal}}`) as JsonObject;
}

/** Judges `payload` and checks the AC-RUA-042 outcome; returns the rejection detail. */
async function expectRecordedRejection(
  harness: ProviderHarness,
  pk: string,
  payload: JsonValue,
  reason: string,
): Promise<string> {
  const response = await harness.provider.handle(payload);
  assert.equal(field(response, 'outcome'), 'REJECTED');
  assert.equal(field(response, 'rejection_reason'), reason);
  assert.deepEqual(providerEventTypes(harness, pk), ['provider_call_received', 'provider_call_rejected']);
  const received = onlyEvent(harness, pk, 'provider_call_received');
  const rejected = onlyEvent(harness, pk, 'provider_call_rejected');
  const callId = field(response, 'provider_call_id');
  assert.ok(isUuid4(callId));
  assert.equal(field(received, 'provider_call_id'), callId);
  assert.equal(field(rejected, 'provider_call_id'), callId);
  assert.equal(field(rejected, 'reason'), reason);
  assert.deepEqual(ledgerItems(harness, pk), []);
  assert.deepEqual(treatmentItem(harness, pk), armedTreatmentItem(pk));
  const detail = field(rejected, 'detail');
  assert.equal(typeof detail, 'string');
  return detail as string;
}

/** The digest of a canonical text in which `placeholder` stands for a non-finite token. */
function digestWithToken(call: JsonObject, member: string, placeholder: number, token: string): string {
  const text = canonicalJson({ ...call, [member]: placeholder }).replace(
    `${JSON.stringify(member)}:${String(placeholder)}`,
    `${JSON.stringify(member)}:${token}`,
  );
  return sha256Hex(UTF8.encode(text));
}

function armedTrial(): ProviderHarness {
  const harness = providerHarness();
  seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
  return harness;
}

describe('RefundProvider over runtime-parsed hostile payloads', () => {
  it('rejects amount_minor 1e400 (Infinity) as AMOUNT_INVALID and digests it with an Infinity token', async () => {
    const harness = armedTrial();
    const payload = parsedWith(validCall(), 'amount_minor', '1e400');
    assert.equal(payload['amount_minor'], Number.POSITIVE_INFINITY);
    const detail = await expectRecordedRejection(harness, TRIAL_PK, payload, 'AMOUNT_INVALID');

    assert.equal(detail, 'amount_minor Infinity; expected a safe integer >= 1 (at most 9007199254740991)');
    const received = onlyEvent(harness, TRIAL_PK, 'provider_call_received');
    assert.equal(
      field(received, 'raw_request_sha256'),
      digestWithToken(validCall(), 'amount_minor', 424242, 'Infinity'),
    );
  });

  it('rejects amount_minor -1e400 as AMOUNT_INVALID with a distinct digest', async () => {
    const harness = armedTrial();
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(validCall(), 'amount_minor', '-1e400'),
      'AMOUNT_INVALID',
    );
    assert.equal(detail, 'amount_minor -Infinity; expected a safe integer >= 1 (at most 9007199254740991)');
    assert.equal(
      field(onlyEvent(harness, TRIAL_PK, 'provider_call_received'), 'raw_request_sha256'),
      digestWithToken(validCall(), 'amount_minor', 424242, '-Infinity'),
    );
  });

  it('rejects caller_id 1e400 as AUTHORIZATION_FAILED and names the value Infinity', async () => {
    const harness = armedTrial();
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(validCall(), 'caller_id', '1e400'),
      'AUTHORIZATION_FAILED',
    );
    assert.equal(detail, 'caller_id number Infinity; expected the registered caller "conventional"');
  });

  it('rejects an unknown property holding -1e400 as SCHEMA_INVALID', async () => {
    const harness = armedTrial();
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(validCall(), 'x', '-1e400'),
      'SCHEMA_INVALID',
    );
    assert.match(detail, /^property "x" is not part of provider_refund_call; expected only schema_version, /u);
  });

  it('rejects deep nesting in caller_id as AUTHORIZATION_FAILED with a bounded detail', async () => {
    const harness = armedTrial();
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(validCall(), 'caller_id', DEEP_ARRAY_TEXT),
      'AUTHORIZATION_FAILED',
    );
    const excerpt = '['.repeat(QUOTED_JSON_LIMIT);
    assert.equal(detail, `caller_id array ${excerpt}${TRUNCATED}; expected the registered caller "conventional"`);
  });

  it('rejects deep nesting in amount_minor and in an unknown property as SCHEMA_INVALID', async () => {
    const inAmount = armedTrial();
    const amountDetail = await expectRecordedRejection(
      inAmount,
      TRIAL_PK,
      parsedWith(validCall(), 'amount_minor', DEEP_OBJECT_TEXT),
      'SCHEMA_INVALID',
    );
    assert.match(amountDetail, /^amount_minor is object \{"a":\{"a":/u);
    assert.match(amountDetail, /…\[truncated\]; expected a JSON number$/u);
    assert.ok(amountDetail.length <= DETAIL_BOUND, String(amountDetail.length));

    const inUnknown = armedTrial();
    const unknownDetail = await expectRecordedRejection(
      inUnknown,
      TRIAL_PK,
      parsedWith(validCall(), 'deep', DEEP_ARRAY_TEXT),
      'SCHEMA_INVALID',
    );
    assert.match(unknownDetail, /^property "deep" is not part of provider_refund_call/u);
  });

  it('bounds an oversized unknown key in the detail', async () => {
    const harness = armedTrial();
    const longKey = 'k'.repeat(10_000);
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(validCall(), longKey, '1'),
      'SCHEMA_INVALID',
    );
    assert.ok(detail.startsWith(`property "${'k'.repeat(QUOTED_JSON_LIMIT - 1)}${TRUNCATED}`));
    assert.ok(detail.length <= DETAIL_BOUND + 300, String(detail.length));
  });

  it('records a probe call with amount -1e400 or a deeply nested payload in the probe partition', async () => {
    const amount = providerHarness(PROBE);
    seedProbe(amount);
    await expectRecordedRejection(
      amount,
      PROBE_PK,
      parsedWith(validProbeCall(), 'amount_minor', '-1e400'),
      'AMOUNT_INVALID',
    );

    const nested = providerHarness(PROBE);
    seedProbe(nested);
    const detail = await expectRecordedRejection(
      nested,
      PROBE_PK,
      JSON.parse(DEEP_ARRAY_TEXT) as JsonValue,
      'AUTHORIZATION_FAILED',
    );
    assert.equal(detail, 'caller_id absent; expected the registered caller "probe"');
  });

  it('rejects own members named like Object.prototype members as SCHEMA_INVALID', async () => {
    for (const member of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const harness = armedTrial();
      const payload = parsedWith(validCall(), member, '{"caller_id":"conventional"}');
      assert.ok(Object.hasOwn(payload, member));
      const detail = await expectRecordedRejection(harness, TRIAL_PK, payload, 'SCHEMA_INVALID');
      assert.ok(detail.startsWith(`property ${JSON.stringify(member)} is not part of provider_refund_call`), detail);
    }
  });

  it('never reads the caller through an own __proto__ member (authorization comes first)', async () => {
    const withoutCaller = Object.fromEntries(Object.entries(validCall()).filter(([key]) => key !== 'caller_id'));
    const harness = armedTrial();
    const detail = await expectRecordedRejection(
      harness,
      TRIAL_PK,
      parsedWith(withoutCaller, '__proto__', '{"caller_id":"conventional"}'),
      'AUTHORIZATION_FAILED',
    );
    assert.equal(detail, 'caller_id absent; expected the registered caller "conventional"');
  });

  it('refuses a warm-up with a non-finite or deeply nested member as WARMUP_REQUEST_INVALID', async () => {
    const warmup: JsonObject = {
      schema_version: 1,
      record_type: 'provider_warmup_request',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      warmup_id: WARMUP_ID,
    };
    const harness = providerHarness();
    const infinite = await expectProviderFault(
      harness.provider.handle(parsedWith(warmup, 'trial_id', '1e400')),
      'WARMUP_REQUEST_INVALID',
      'before_commit',
    );
    assert.match(
      infinite.message,
      /trial_id is number Infinity; expected a lowercase RFC 4122 version-4 UUID when present$/u,
    );
    const deep = await expectProviderFault(
      harness.provider.handle(parsedWith(warmup, 'warmup_id', DEEP_ARRAY_TEXT)),
      'WARMUP_REQUEST_INVALID',
      'before_commit',
    );
    assert.match(deep.message, /warmup_id is array \[{200}…\[truncated\]; expected a lowercase/u);
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('refuses a warm-up with own members named like Object.prototype members', async () => {
    const warmup: JsonObject = {
      schema_version: 1,
      record_type: 'provider_warmup_request',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      warmup_id: WARMUP_ID,
    };
    const harness = providerHarness();
    // `hasOwnProperty` is the minimized input of the warm-up differential (seed 1709518504): the
    // guard refuses it although the group-B schema still accepts it on this branch (A-07).
    for (const member of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const fault = await expectProviderFault(
        harness.provider.handle(parsedWith(warmup, member, '{"warmup_id":1}')),
        'WARMUP_REQUEST_INVALID',
        'before_commit',
      );
      assert.match(fault.message, new RegExp(`property "${member}" is not part of provider_warmup_request`, 'u'));
    }
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });
});
