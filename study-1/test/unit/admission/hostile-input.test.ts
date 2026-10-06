// Permanent A-05 regressions of every untrusted admission boundary (WP-23 review): the operator's
// financial records, the request's variant, the environment input bytes, the golden run-suite
// report and case declarations, and the AWS read outputs. Each answers towers 100,000 levels deep
// (array, object and mixed), non-finite numbers (`1e400` parses to Infinity) and inherited member
// names without throwing: it refuses with a bounded detail, or reads own members only. The fuzz
// properties in `test/fuzz/admission` sample the same space; these fixed cases keep the floor
// A-05 sets even when a fuzz run happens to draw no such value. The ownership strategy has its
// own cases in `ownership-strategy.test.ts`.
//
// Boundary: the pure step functions and mappers, fed values parsed by the kernel parser or
// `JSON.parse` exactly as the adapters hand them over.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bootstrapStatusOf,
  callerIdentityOf,
  coordinationTableOf,
  unreservedConcurrencyOf,
} from '../../../src/admission/cloud-readings.ts';
import { OR_RUA_001_APPROVED_DECISION, OR_RUA_001_PAYMENT } from '../../../src/admission/declared-inputs.ts';
import { assessEnvironmentInput, validateEnvironmentInput } from '../../../src/admission/environment-input.ts';
import { assessFinancialInput, assessIdentityInput } from '../../../src/admission/financial-input.ts';
import { caseDeclarationOf, parseSuiteReport } from '../../../src/admission/golden-report.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { environmentInput } from '../../support/admission/admission-fixtures.ts';
import { DEEP_NESTING, parsedTower, towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';

const SHAPES: readonly TowerShape[] = ['array', 'object', 'mixed'];
const MAX_DETAIL = 2_000;
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const validator = createRecordValidator();
const encoder = new TextEncoder();

function assertBounded(details: readonly string[], label: string): void {
  assert.ok(details.length > 0, `${label}: a refusal names at least one reason`);
  for (const detail of details) {
    assert.ok(detail.length <= MAX_DETAIL, `${label}: detail of ${String(detail.length)} characters`);
  }
}

function reasonDetails(reasons: readonly StructuredReason[]): readonly string[] {
  return reasons.map((reason) => reason.detail);
}

function refusedDetail<T>(result: Result<T, { readonly detail: string }>, label: string): string {
  assert.ok(!result.ok, `${label} is refused`);
  return result.error.detail;
}

// A record whose `member` is inherited from its prototype instead of owned.
function inheriting(base: JsonObject, member: string): JsonObject {
  const { [member]: inherited, ...own } = base;
  return Object.assign(Object.create({ [member]: inherited }) as JsonObject, own);
}

describe('A-05: admission stays total on hostile input', () => {
  for (const shape of SHAPES) {
    it(`A3 and A4 refuse a ${shape} tower of ${String(DEEP_NESTING)} levels in any member, bounded`, () => {
      const tower = parsedTower(shape);
      const asRecords = assessFinancialInput({ payment: tower, approved_decision: tower });
      assert.ok(!asRecords.passed);
      assertBounded(reasonDetails(asRecords.reasons), 'tower records');
      const asAmount = assessFinancialInput({
        payment: { ...OR_RUA_001_PAYMENT, captured_amount_minor: tower },
        approved_decision: { ...OR_RUA_001_APPROVED_DECISION, currency: tower },
      });
      assert.ok(!asAmount.passed);
      assertBounded(reasonDetails(asAmount.reasons), 'tower members');
      const identity = assessIdentityInput(
        { payment: { ...OR_RUA_001_PAYMENT, payment_id: tower }, decision: OR_RUA_001_APPROVED_DECISION },
        'VARIANT_VALIDATION',
        tower,
      );
      assert.ok(!identity.passed);
      assert.deepEqual(
        identity.reasons.map((reason) => reason.code),
        ['IDENTIFIER_EMPTY', 'EXECUTION_VARIANT_INVALID'],
      );
      assertBounded(reasonDetails(identity.reasons), 'tower identity');
    });
  }

  it('A3 refuses non-finite amounts by name and reads amounts and identifiers as own members only', () => {
    const verdict = assessFinancialInput({
      payment: { ...OR_RUA_001_PAYMENT, captured_amount_minor: JSON.parse('1e400') as number },
      approved_decision: { ...OR_RUA_001_APPROVED_DECISION, approved_amount_minor: Number.NEGATIVE_INFINITY },
    });
    assert.ok(!verdict.passed);
    assert.deepEqual(
      verdict.reasons.map((reason) => [reason.code, reason.detail.includes('Infinity')]),
      [
        ['AMOUNT_NOT_POSITIVE_INTEGER', true],
        ['AMOUNT_NOT_POSITIVE_INTEGER', true],
      ],
    );
    const inheritedDecision = inheriting(OR_RUA_001_APPROVED_DECISION, 'approved_amount_minor');
    const inherited = assessFinancialInput({ payment: OR_RUA_001_PAYMENT, approved_decision: inheritedDecision });
    assert.ok(!inherited.passed);
    assert.deepEqual(
      inherited.reasons.map((reason) => reason.code),
      ['AMOUNT_NOT_POSITIVE_INTEGER'],
    );
    const identity = assessIdentityInput(
      { payment: inheriting(OR_RUA_001_PAYMENT, 'payment_id'), decision: OR_RUA_001_APPROVED_DECISION },
      'RUN',
      undefined,
    );
    assert.ok(!identity.passed);
    assert.deepEqual(
      identity.reasons.map((reason) => reason.detail.startsWith('payment.payment_id is absent')),
      [true],
    );
  });

  for (const shape of SHAPES) {
    it(`A2 refuses a ${shape} tower of ${String(DEEP_NESTING)} levels as the file and as a member, bounded`, () => {
      const whole = assessEnvironmentInput(encoder.encode(towerText(shape, DEEP_NESTING, '1')), validator);
      assert.ok(!whole.passed);
      assertBounded(reasonDetails(whole.reasons), 'tower file');
      const member = assessEnvironmentInput(
        encoder.encode(
          JSON.stringify(environmentInput({ region: 0 })).replace(
            '"region":0',
            `"region":${towerText(shape, DEEP_NESTING, '1')}`,
          ),
        ),
        validator,
      );
      assert.ok(!member.passed);
      assert.equal(member.rejection_class, 'ACCOUNT');
      assertBounded(reasonDetails(member.reasons), 'tower member');
    });
  }

  it('A2 refuses an overflowing number as unreadable and a member named after Object.prototype as unknown', () => {
    // A2 reads the file's bytes, and parsed JSON owns every member it has: `__proto__` and the
    // Object.prototype names arrive as own members, which the closed schema refuses.
    const overflow = assessEnvironmentInput(encoder.encode('{"schema_version":1e400}'), validator);
    assert.ok(!overflow.passed);
    assert.deepEqual(
      overflow.reasons.map((reason) => reason.code),
      ['ENVIRONMENT_INPUT_UNREADABLE'],
    );
    const admissible = JSON.stringify(environmentInput()).slice(1);
    for (const name of INHERITED_NAMES) {
      const verdict = assessEnvironmentInput(encoder.encode(`{"${name}":{},${admissible}`), validator);
      assert.ok(!verdict.passed, name);
      assert.equal(verdict.rejection_class, 'ACCOUNT', name);
      assertBounded(reasonDetails(verdict.reasons), name);
    }
    const shadowed = assessEnvironmentInput(
      encoder.encode(`{"__proto__":${JSON.stringify(environmentInput())}}`),
      validator,
    );
    assert.ok(!shadowed.passed);
    assert.equal(validateEnvironmentInput(JSON.parse('{"__proto__":{}}') as JsonValue, validator).ok, false);
  });

  for (const shape of SHAPES) {
    it(`A9 refuses a ${shape} tower of ${String(DEEP_NESTING)} levels as the report, its counts and a case`, () => {
      const tower = towerText(shape, DEEP_NESTING, '1');
      for (const text of [tower, `{"suite":"golden","counts":${tower}}`, `{"suite":${tower}}`]) {
        const report = parseSuiteReport(encoder.encode(text));
        assert.ok(!report.ok);
        assertBounded([report.error], 'tower report');
      }
      assert.equal(caseDeclarationOf(parsedTower(shape)), undefined);
      assert.equal(caseDeclarationOf({ case_id: 'deep', rule_outcomes_reached: [parsedTower(shape)] }), undefined);
    });
  }

  it('A9 refuses overflowing counts and reads report and case members as own members only', () => {
    const overflow = parseSuiteReport(encoder.encode('{"suite":"golden","minimum":1e400}'));
    assert.ok(!overflow.ok);
    assert.match(overflow.error, /^the report is not one JSON document/);
    const shadowed = parseSuiteReport(encoder.encode('{"__proto__":{"suite":"golden"}}'));
    assert.deepEqual(shadowed, { ok: false, error: 'suite is absent; expected a string' });
    const declared = { case_id: 'inherited', rule_outcomes_reached: [] };
    for (const name of ['case_id', 'rule_outcomes_reached']) {
      assert.equal(caseDeclarationOf(inheriting(declared, name)), undefined, name);
    }
    const pair = Object.create({ rule_id: 'BR-RUA-006', outcome: 'pass' }) as JsonObject;
    assert.equal(caseDeclarationOf({ case_id: 'x', rule_outcomes_reached: [pair] }), undefined);
  });

  for (const shape of SHAPES) {
    it(`the AWS read mappers refuse a ${shape} tower of ${String(DEEP_NESTING)} levels anywhere, bounded`, () => {
      const tower = parsedTower(shape);
      const details = [
        refusedDetail(callerIdentityOf(tower, 'us-east-1'), 'caller identity'),
        refusedDetail(callerIdentityOf({ Account: tower, Arn: tower }, tower), 'caller identity members'),
        refusedDetail(unreservedConcurrencyOf({ AccountLimit: { UnreservedConcurrentExecutions: tower } }), 'limit'),
        refusedDetail(bootstrapStatusOf({ Stacks: [{ StackStatus: tower }] }), 'bootstrap status'),
        refusedDetail(bootstrapStatusOf({ Stacks: tower }), 'bootstrap stacks'),
        refusedDetail(coordinationTableOf({ Table: { TableArn: tower, KeySchema: tower } }, tower), 'table'),
      ];
      assertBounded(details, shape);
    });
  }

  it('the AWS read mappers refuse non-finite limits and never read inherited members', () => {
    for (const limit of [JSON.parse('1e400') as number, Number.NaN, -1]) {
      assert.match(
        refusedDetail(unreservedConcurrencyOf({ AccountLimit: { UnreservedConcurrentExecutions: limit } }), 'limit'),
        /expected a nonnegative safe integer$/,
      );
    }
    for (const name of INHERITED_NAMES) {
      const output = Object.create({ Account: '012345678901', Arn: 'arn:aws:iam::012345678901:user/x' }) as object;
      Object.defineProperty(output, name, { value: 1, enumerable: true });
      assert.equal(callerIdentityOf(output, 'us-east-1').ok, false, name);
    }
    const inheritedStacks = Object.create({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }) as object;
    assert.equal(bootstrapStatusOf(inheritedStacks).ok, false);
    const inheritedLimit = { AccountLimit: Object.create({ UnreservedConcurrentExecutions: 1000 }) as object };
    assert.equal(unreservedConcurrencyOf(inheritedLimit).ok, false);
  });
});
