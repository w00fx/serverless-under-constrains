// Property tests of admission's untrusted-input boundaries (testing rule 6; A-05 totality):
// operator financial records, the environment input, the golden run-suite report, the golden case
// declarations and the AWS read outputs. Over any JSON (towers nested past the call stack,
// non-finite numbers and inherited member names included) each one answers without throwing; a
// refusal is nonempty and every detail stays bounded. Runs FC_RUNS cases per property (10,000
// under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  bootstrapStatusOf,
  callerIdentityOf,
  coordinationTableOf,
  unreservedConcurrencyOf,
} from '../../../src/admission/cloud-readings.ts';
import { validateEnvironmentInput } from '../../../src/admission/environment-input.ts';
import { assessFinancialInput, validateFinancialInput } from '../../../src/admission/financial-input.ts';
import { caseDeclarationOf, parseSuiteReport } from '../../../src/admission/golden-report.ts';
import type { JsonValue, StructuredReason } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { OR_RUA_001_APPROVED_DECISION, OR_RUA_001_PAYMENT } from '../../../src/admission/declared-inputs.ts';
import { deepTowerArbitrary, towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const MAX_DETAIL = 2_000;
const validator = createRecordValidator();
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

const hostileLeaf: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 2 ** 53, ''),
  fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
);

const inheritedObject: fc.Arbitrary<JsonValue> = fc
  .dictionary(fc.constantFrom(...INHERITED_NAMES), hostileLeaf, { maxKeys: 3 })
  .map((members) => JSON.parse(JSON.stringify(members)) as JsonValue);

const anyJson: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: fc.jsonValue() as fc.Arbitrary<JsonValue>, weight: 40 },
  { arbitrary: hostileLeaf, weight: 5 },
  { arbitrary: inheritedObject, weight: 5 },
  { arbitrary: deepTowerArbitrary(), weight: 1 },
);

// A real record with one member replaced or removed, so most values reach the deeper checks.
function nearRecord(base: Readonly<Record<string, JsonValue>>): fc.Arbitrary<JsonValue> {
  return fc
    .tuple(fc.constantFrom(...Object.keys(base), ...INHERITED_NAMES), fc.option(hostileLeaf, { nil: undefined }))
    .map(([member, value]) => {
      const copy: Record<string, JsonValue> = Object.fromEntries(
        Object.entries(base).filter(([name]) => name !== member),
      );
      if (value !== undefined) {
        Object.defineProperty(copy, member, { value, enumerable: true, writable: true, configurable: true });
      }
      return copy;
    });
}

function assertBounded(reasons: readonly StructuredReason[]): void {
  for (const reason of reasons) {
    assert.ok(reason.detail.length <= MAX_DETAIL, `detail of ${String(reason.detail.length)} characters`);
  }
}

describe('financial input properties', () => {
  it('validates any pair of values without throwing, with bounded details', () => {
    const payment = fc.oneof(anyJson, nearRecord(OR_RUA_001_PAYMENT));
    const decision = fc.oneof(anyJson, nearRecord(OR_RUA_001_APPROVED_DECISION));
    fc.assert(
      fc.property(payment, decision, (paymentValue, decisionValue) => {
        assertBounded(validateFinancialInput(paymentValue, decisionValue));
        const verdict = assessFinancialInput({ payment: paymentValue, approved_decision: decisionValue });
        if (!verdict.passed) {
          assert.ok(verdict.reasons.length > 0);
          assertBounded(verdict.reasons);
        }
      }),
      fuzzParameters(),
    );
  });

  it('admits the declared OR-RUA-001 pair and refuses any changed amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (amount) => {
        fc.pre(amount !== OR_RUA_001_PAYMENT['captured_amount_minor']);
        const verdict = assessFinancialInput({
          payment: { ...OR_RUA_001_PAYMENT, captured_amount_minor: amount },
          approved_decision: OR_RUA_001_APPROVED_DECISION,
        });
        assert.ok(!verdict.passed);
        assert.deepEqual(
          verdict.reasons.map((reason) => reason.code),
          ['AMOUNTS_UNEQUAL'],
        );
      }),
      fuzzParameters(),
    );
    assert.ok(
      assessFinancialInput({ payment: OR_RUA_001_PAYMENT, approved_decision: OR_RUA_001_APPROVED_DECISION }).passed,
    );
  });
});

describe('environment input properties', () => {
  it('validates any JSON without throwing; a refusal is a summary plus at most three violations', () => {
    fc.assert(
      fc.property(anyJson, (raw) => {
        const validated = validateEnvironmentInput(raw, validator);
        if (!validated.ok) {
          assert.ok(validated.error.length >= 1 && validated.error.length <= 4);
          assert.ok(validated.error.every((reason) => reason.code === 'ENVIRONMENT_INPUT_INVALID'));
          assertBounded(validated.error);
        }
      }),
      fuzzParameters(),
    );
  });
});

describe('golden report properties', () => {
  it('parses any bytes and any JSON without throwing, with a bounded error', () => {
    const encoder = new TextEncoder();
    // Towers are written as text: JSON.stringify itself recurses and cannot serialize them.
    const bytes = fc.oneof(
      { arbitrary: fc.uint8Array({ maxLength: 64 }), weight: 10 },
      { arbitrary: fc.jsonValue().map((value) => encoder.encode(JSON.stringify(value))), weight: 30 },
      {
        arbitrary: fc
          .record({
            shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
            depth: fc.integer({ min: 2_500, max: 20_000 }),
          })
          .map(({ shape, depth }) => encoder.encode(towerText(shape, depth, '1'))),
        weight: 1,
      },
    );
    fc.assert(
      fc.property(bytes, (report) => {
        const parsed = parseSuiteReport(report);
        if (!parsed.ok) {
          assert.ok(parsed.error.length <= MAX_DETAIL, `error of ${String(parsed.error.length)} characters`);
        }
      }),
      fuzzParameters(),
    );
  });

  it('reads a case declaration only from own string members', () => {
    fc.assert(
      fc.property(fc.oneof(anyJson, fc.anything()), (value) => {
        const declaration = caseDeclarationOf(value);
        if (declaration !== undefined) {
          assert.equal(typeof declaration.case_id, 'string');
          assert.ok(declaration.rule_outcomes.every((pair) => typeof pair.rule_id === 'string'));
        }
      }),
      fuzzParameters(),
    );
  });
});

describe('AWS read output properties', () => {
  it('maps any output without throwing; a failure names its operation with a bounded detail', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (output, other) => {
        for (const read of [
          callerIdentityOf(output, other),
          unreservedConcurrencyOf(output),
          bootstrapStatusOf(output),
          coordinationTableOf(output, other),
        ]) {
          if (!read.ok) {
            assert.match(read.error.code, /OutputMalformed$/);
            assert.ok(
              read.error.detail.length <= MAX_DETAIL,
              `detail of ${String(read.error.detail.length)} characters`,
            );
          }
        }
      }),
      fuzzParameters(),
    );
  });
});
