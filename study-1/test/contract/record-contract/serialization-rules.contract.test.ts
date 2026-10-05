// AC-RUA-046 serialization rules (BR-RUA-033), proven through the public validation contract:
// the committed shared `$defs` and the CAP-RUA Ajv vocabulary, loaded from disk by the real
// node filesystem adapter, against the kernel's fixture catalogue. Catalogue packages WP-01..03
// prove the same rules per record type.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../src/record-contract/schema-registry.ts';
import {
  FIXTURE_CATALOGUE_ROOT,
  SAMPLE_UUIDS,
  SHARED_DEFS_PATH,
  sampleDispatchStarted,
  sampleOracleResult,
  samplePayment,
} from '../../support/kernel/schema-fixtures.ts';

const validator = createRecordValidator({ schemaRoot: FIXTURE_CATALOGUE_ROOT, defsPath: SHARED_DEFS_PATH });

function violationsOf(result: RecordValidation): readonly string[] {
  return result.valid ? [] : result.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`);
}

function assertRejected(record: JsonObject, expected: string, label: string): void {
  assert.ok(
    violationsOf(validator.validate(record)).includes(expected),
    `${label}: expected violation "${expected}", got ${JSON.stringify(violationsOf(validator.validate(record)))}`,
  );
}

function assertAccepted(record: JsonObject, label: string): void {
  assert.deepEqual(violationsOf(validator.validate(record)), [], label);
}

describe('AC-RUA-046 serialization rules', () => {
  it('casing', () => {
    assertAccepted(samplePayment(), 'snake_case record');
    assertRejected({ ...samplePayment(), paymentId: SAMPLE_UUIDS.payment }, ' additionalProperties', 'camelCase field');
    assertRejected(
      { ...sampleDispatchStarted(), attemptId: SAMPLE_UUIDS.attempt },
      ' unevaluatedProperties',
      'camelCase event field',
    );
    assert.equal(
      validator.validate({ ...samplePayment(), record_type: 'Payment' }).valid,
      false,
      'record_type is lowercase snake_case',
    );
    assertRejected(
      { ...sampleOracleResult(), reasons: [{ code: 'missing_artifact', subject: 'ledger', detail: 'absent' }] },
      '/reasons/0/code pattern',
      'lowercase reason code',
    );
    assertAccepted(
      {
        ...sampleOracleResult(),
        result: 'indeterminate',
        evidence_refs: [],
        reasons: [{ code: 'MISSING_ARTIFACT', subject: 'ledger', detail: 'ledger/ledger-snapshot.json is absent' }],
      },
      'UPPER_SNAKE reason code',
    );
    assertRejected({ ...sampleDispatchStarted(), source: 'ConventionalCaller' }, '/source enum', 'enum value casing');
  });

  it('millisecond UTC', () => {
    assertAccepted({ ...sampleDispatchStarted(), occurred_at: '2026-10-05T23:59:59.999Z' }, 'millisecond UTC instant');
    for (const value of [
      '2026-10-05T12:00:00Z',
      '2026-10-05T12:00:00.000123Z',
      '2026-10-05T12:00:00.000+00:00',
      '2026-10-05T12:00:00.000z',
      '2026-02-30T12:00:00.000Z',
    ]) {
      assert.equal(validator.validate({ ...sampleDispatchStarted(), occurred_at: value }).valid, false, value);
    }
    assertRejected(
      { ...samplePayment(), captured_at: '2026-02-30T12:00:00.000Z' },
      '/captured_at format',
      'impossible calendar date',
    );
    assertRejected({ ...samplePayment(), captured_at: 1791230400000 }, '/captured_at type', 'epoch number');
  });

  it('lowercase UUIDv4', () => {
    assertAccepted({ ...samplePayment(), payment_id: crypto.randomUUID() }, 'random lowercase v4');
    assertRejected(
      { ...samplePayment(), payment_id: SAMPLE_UUIDS.payment.toUpperCase() },
      '/payment_id pattern',
      'uppercase',
    );
    assertRejected(
      { ...samplePayment(), payment_id: '3f1c2a9e-8b4d-1c1e-9f00-1a2b3c4d5e6f' },
      '/payment_id pattern',
      'version 1',
    );
    assertRejected(
      { ...samplePayment(), payment_id: '3f1c2a9e8b4d4c1e9f001a2b3c4d5e6f' },
      '/payment_id pattern',
      'unhyphenated',
    );
    assertRejected(
      { ...sampleDispatchStarted(), event_id: '00000000-0000-4000-C000-000000000001' },
      '/event_id pattern',
      'uppercase variant',
    );
    assertRejected(
      { ...sampleDispatchStarted(), causation_event_ids: ['ABC'] },
      '/causation_event_ids/0 pattern',
      'causation id',
    );
  });

  it('safe-integer amounts', () => {
    assertAccepted({ ...samplePayment(), captured_amount_minor: 9007199254740991 }, 'max safe integer');
    assertAccepted(
      parseJsonOrThrow(
        '{"schema_version":1,"record_type":"payment","payment_id":"3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f","captured_amount_minor":1.0,"refunded_total_minor":"0","captured_at":"2026-10-05T12:00:00.000Z","currency":"BRL"}',
      ),
      'integral JSON number 1.0',
    );
    assertRejected(
      { ...samplePayment(), captured_amount_minor: 9007199254740992 },
      '/captured_amount_minor maximum',
      'beyond 2^53 - 1',
    );
    assertRejected({ ...samplePayment(), captured_amount_minor: 0 }, '/captured_amount_minor minimum', 'zero');
    assertRejected({ ...samplePayment(), captured_amount_minor: 100.5 }, '/captured_amount_minor type', 'fraction');
    assertRejected({ ...samplePayment(), captured_amount_minor: '10000' }, '/captured_amount_minor type', 'string');
    assertRejected(
      { ...sampleDispatchStarted(), source_sequence: 0 },
      '/source_sequence minimum',
      'sequence starts at 1',
    );
  });

  it('decimal aggregates', () => {
    assertAccepted({ ...samplePayment(), refunded_total_minor: '18014398509481982' }, 'aggregate beyond 2^53');
    for (const value of ['01', '-1', '1.0', ' 1', '1e3', '']) {
      assertRejected(
        { ...samplePayment(), refunded_total_minor: value },
        '/refunded_total_minor pattern',
        `aggregate ${JSON.stringify(value)}`,
      );
    }
    assertRejected(
      { ...samplePayment(), refunded_total_minor: 20000 },
      '/refunded_total_minor type',
      'number aggregate',
    );
    assertAccepted(
      { ...sampleOracleResult(), elapsed_ns: '3000000000', skew_ms: '-1000', cost_usd: '0.0000166667' },
      'decimal strings',
    );
    assertRejected({ ...sampleOracleResult(), skew_ms: '-0' }, '/skew_ms pattern', 'negative zero');
    assertRejected({ ...sampleOracleResult(), cost_usd: '.5' }, '/cost_usd pattern', 'money without integer part');
  });

  it('omitted versus null', () => {
    assertAccepted(samplePayment(), 'optional note omitted');
    assertAccepted({ ...samplePayment(), note: 'chargeback review' }, 'optional note present');
    assertRejected({ ...samplePayment(), note: null }, '/note type', 'optional note as null');
    assertRejected(
      { ...sampleDispatchStarted(), trial_id: null, trial_manifest_sha256: null },
      '/trial_id type',
      'trial fields as null',
    );
    assertRejected(
      { ...sampleDispatchStarted(), causation_event_ids: [] },
      '/causation_event_ids minItems',
      'empty causation instead of omission',
    );
    assertRejected(
      { ...sampleDispatchStarted(), trial_id: SAMPLE_UUIDS.trial },
      ' dependentRequired',
      'trial_id without its manifest digest',
    );
    assertAccepted(
      {
        ...sampleDispatchStarted(),
        trial_id: SAMPLE_UUIDS.trial,
        trial_manifest_sha256: 'd'.repeat(64),
        causation_event_ids: [SAMPLE_UUIDS.causeA, SAMPLE_UUIDS.causeB],
      },
      'trial-scoped event with causes',
    );
    assertRejected(
      { ...sampleDispatchStarted(), causation_event_ids: [SAMPLE_UUIDS.causeB, SAMPLE_UUIDS.causeA] },
      '/causation_event_ids x-rua-ascending-unique',
      'unsorted causes',
    );
    const withUndefined = { ...samplePayment(), note: undefined } as unknown as StudyRecord;
    assert.throws(
      () => serializeRecordFile(withUndefined),
      /value at \$\.note is of type undefined/,
      'an undefined optional is never serialized as null or dropped silently',
    );
    assert.equal(canonicalJson(samplePayment()).includes('note'), false);
  });

  it('schema_version and record_type present', () => {
    const { schema_version: _version, ...withoutVersion } = samplePayment();
    assertRejected(withoutVersion, ' required', 'missing schema_version');
    assertRejected({ ...samplePayment(), schema_version: 2 }, '/schema_version const', 'unknown schema_version');
    const { record_type: _type, ...withoutType } = samplePayment();
    assert.deepEqual(violationsOf(validator.validate(withoutType)), ['/record_type record_type']);
    const { schema_version: _v, record_type: _t, ...bareEvent } = sampleDispatchStarted();
    assert.deepEqual(violationsOf(validator.validateAs('dispatch_started', bareEvent)), ['/record_type record_type']);
    const { run_id: _run, ...withoutIdentity } = sampleDispatchStarted();
    assertRejected(withoutIdentity, ' oneOf', 'no execution identity');
    assertRejected(
      { ...withoutIdentity, transport_probe_id: SAMPLE_UUIDS.run, variant_validation_id: SAMPLE_UUIDS.run },
      ' oneOf',
      'two execution identities',
    );
    assertAccepted({ ...withoutIdentity, transport_probe_id: SAMPLE_UUIDS.run }, 'probe identity');
  });
});

function parseJsonOrThrow(text: string): JsonObject {
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new Error(`fixture ${text} is not a JSON object; expected a record`);
  }
  return parsed.value as JsonObject;
}
