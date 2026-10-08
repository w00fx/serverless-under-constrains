// One step's verdict and its records (BR-RUA-039): a passing and a failing verdict, the nonempty
// guarantee of `failedWithAll`, `verdictOf` choosing by its reasons, and the journal and
// rejection records built from a verdict, each valid against its schema.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { admissionReason, portFailureReason } from '../../../src/admission/admission-reason.ts';
import {
  failed,
  failedWithAll,
  passed,
  preflightRecord,
  rejectionRecord,
  verdictOf,
} from '../../../src/admission/preflight-check.ts';
import type { CheckStatement } from '../../../src/admission/preflight-check.ts';
import type { JsonValue, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';

const validator = createRecordValidator();
const ATTEMPT = '0000a001-0000-4000-8000-000000000001' as Uuid4;
const AT = '2026-10-06T09:00:00.000Z' as UtcMillis;
const STATEMENT: CheckStatement = { subject: 'caller_identity', expected: '012345678901', observed: '012345678901' };
const REASON = admissionReason('ACCOUNT_NOT_ALLOWLISTED', 'BR-RUA-041', 'caller account is 1; expected 012345678901');
const FALLBACK = admissionReason('FALLBACK', 'BR-RUA-041', 'fallback; expected a reason');

describe('admission reasons', () => {
  it('builds a reason from code, subject and detail', () => {
    assert.deepEqual(REASON, {
      code: 'ACCOUNT_NOT_ALLOWLISTED',
      subject: 'BR-RUA-041',
      detail: 'caller account is 1; expected 012345678901',
    });
  });

  it('keeps a port failure inside a bounded detail', () => {
    assert.deepEqual(portFailureReason('X_UNREADABLE', 'BR-RUA-053', 'the read', { code: 'EIO', detail: 'disk' }), {
      code: 'X_UNREADABLE',
      subject: 'BR-RUA-053',
      detail: 'the read failed with EIO: disk; expected a successful read',
    });
    const huge = portFailureReason('X', 'BR-RUA-053', 'r', { code: 'C', detail: 'z'.repeat(100_000) });
    assert.ok(huge.detail.length < 1000, `detail of ${String(huge.detail.length)} characters`);
  });
});

describe('step verdicts', () => {
  it('passed and failed carry their parts', () => {
    assert.deepEqual(passed(7, STATEMENT), { passed: true, value: 7, statement: STATEMENT });
    assert.deepEqual(failed('ACCOUNT', STATEMENT, [REASON]), {
      passed: false,
      statement: STATEMENT,
      rejection_class: 'ACCOUNT',
      reasons: [REASON],
    });
  });

  it('failedWithAll keeps every given reason, or the fallback when there is none', () => {
    const second = { ...REASON, code: 'SECOND' };
    assert.deepEqual(
      failedWithAll('SAFETY', STATEMENT, [REASON, second], FALLBACK),
      failed('SAFETY', STATEMENT, [REASON, second]),
    );
    assert.deepEqual(failedWithAll('SAFETY', STATEMENT, [], FALLBACK), failed('SAFETY', STATEMENT, [FALLBACK]));
  });

  it('verdictOf passes on no reason and fails on any', () => {
    assert.deepEqual(verdictOf('IDENTITY', STATEMENT, [], 'v'), passed('v', STATEMENT));
    assert.deepEqual(verdictOf('IDENTITY', STATEMENT, [REASON], 'v'), failed('IDENTITY', STATEMENT, [REASON]));
  });
});

describe('step records', () => {
  const context = { admission_attempt_id: ATTEMPT, sequence: 2, check_id: 'A7' as const, checked_at: AT };

  it('a passing step journals result passed with its observation', () => {
    const record = preflightRecord(context, passed(null, STATEMENT));
    assert.deepEqual(record, {
      schema_version: 1,
      record_type: 'preflight_check_recorded',
      admission_attempt_id: ATTEMPT,
      sequence: 2,
      check_id: 'A7',
      subject: 'caller_identity',
      expected: '012345678901',
      observed: '012345678901',
      evidence_refs: [],
      checked_at: AT,
      result: 'passed',
      reasons: [],
    });
    assert.equal(validator.validateAs('preflight_check_recorded', record as unknown as JsonValue).valid, true);
  });

  it('a failing step without an observation journals its class and reasons', () => {
    const record = preflightRecord(context, failed('ACCOUNT', { subject: 'caller_identity', expected: 'x' }, [REASON]));
    assert.equal(Object.hasOwn(record, 'observed'), false);
    assert.equal(record.result, 'failed');
    assert.equal(validator.validateAs('preflight_check_recorded', record as unknown as JsonValue).valid, true);
  });

  it('the rejection names the failed step, its class and its reasons', () => {
    const verdict = failed('ACCOUNT', STATEMENT, [REASON]);
    assert.ok(!verdict.passed);
    const record = rejectionRecord(ATTEMPT, 'RUN', 'A7', verdict, AT);
    assert.deepEqual(record, {
      schema_version: 1,
      record_type: 'admission_rejection',
      admission_attempt_id: ATTEMPT,
      execution_kind: 'RUN',
      rejection_class: 'ACCOUNT',
      failed_check_id: 'A7',
      reasons: [REASON],
      rejected_at: AT,
    });
    assert.equal(validator.validateAs('admission_rejection', record as unknown as JsonValue).valid, true);
  });
});
