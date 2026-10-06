// Admission steps A3 and A4: the financial and identity input of every trial (BR-RUA-017, D-31,
// CTR-RUA-005, CTR-RUA-006). The two records are untrusted parsed JSON, so every read is an own
// property read (A-05) and nothing here throws.
//
// A3 (FINANCIAL_INPUT): both records are closed objects of their record types; `captured_amount_minor`
// and `approved_amount_minor` are positive integers no greater than 9007199254740991 and equal,
// because only full refunds are supported; both currencies are `BRL`; the decision is `APPROVED`;
// and the decision names the payment's `payment_id`.
// A4 (IDENTITY): every required identifier is a string that is nonempty after whitespace trimming.
// It uses the kernel's `nonempty_trimmed` definition, so an identifier padded with whitespace is
// refused rather than silently trimmed: the frozen manifest must hold exactly the given value.

import { isJsonObject, boundedJsonText, describeJson } from '../record-contract/json-value.ts';
import { NONEMPTY_TRIMMED_PATTERN, VARIANT_IDS } from '../record-contract/primitives.ts';
import type { ExecutionKind, JsonObject, JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredFinancialInputs } from '../record-contract/records/group-a/execution_manifest.ts';
import { ownField, unexpectedField } from '../trial-message/trial-message-fields.ts';
import type { FinancialInputRecords } from './admission-ports.ts';
import { admissionReason } from './admission-reason.ts';
import type { ExecutionTarget } from './execution-identities.ts';
import { failed, verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-017';

/** The two records once A3 has proven them JSON objects. */
export interface FinancialInputObjects {
  readonly payment: JsonObject;
  readonly decision: JsonObject;
}
const PAYMENT_MEMBERS: ReadonlySet<string> = new Set([
  'schema_version',
  'record_type',
  'payment_id',
  'captured_amount_minor',
  'currency',
]);
const DECISION_MEMBERS: ReadonlySet<string> = new Set([
  'schema_version',
  'record_type',
  'refund_request_id',
  'payment_id',
  'decision',
  'approved_amount_minor',
  'currency',
]);

/**
 * Every BR-RUA-017 financial problem of the two records (step A3); empty when they are admissible.
 *
 * @example
 * validateFinancialInput(payment, { ...decision, approved_amount_minor: 9000 })[0]?.code; // 'AMOUNTS_UNEQUAL'
 */
export function validateFinancialInput(payment: JsonValue, decision: JsonValue): readonly StructuredReason[] {
  if (!isJsonObject(payment) || !isJsonObject(decision)) {
    return [notObjectReason(payment, decision)];
  }
  const captured = ownField(payment, 'captured_amount_minor');
  const approved = ownField(decision, 'approved_amount_minor');
  return [
    ...recordShapeReasons('payment', payment, PAYMENT_MEMBERS),
    ...recordShapeReasons('approved_decision', decision, DECISION_MEMBERS),
    ...amountReasons('captured_amount_minor', captured),
    ...amountReasons('approved_amount_minor', approved),
    ...equalAmountReasons(captured, approved),
    ...currencyReasons(ownField(payment, 'currency'), ownField(decision, 'currency')),
    ...decisionReasons(ownField(decision, 'decision')),
    ...paymentLinkReasons(ownField(payment, 'payment_id'), ownField(decision, 'payment_id')),
  ];
}

/**
 * Every identifier problem of the two records (step A4); empty when every required identifier is
 * a nonempty trimmed string.
 *
 * @example
 * validateIdentityInput({ payment_id: ' ' }, decision)[0]?.code; // 'IDENTIFIER_EMPTY'
 */
export function validateIdentityInput(payment: JsonObject, decision: JsonObject): readonly StructuredReason[] {
  return [
    identifierReason('payment.payment_id', ownField(payment, 'payment_id')),
    identifierReason('approved_decision.refund_request_id', ownField(decision, 'refund_request_id')),
    identifierReason('approved_decision.payment_id', ownField(decision, 'payment_id')),
  ].filter((reason) => reason !== undefined);
}

/**
 * Step A3 (FINANCIAL_INPUT): the two records, still untyped, become two JSON objects whose
 * financial content BR-RUA-017 admits.
 *
 * @example
 * assessFinancialInput({ payment, approved_decision }).passed; // true for the OR-RUA-001 fixture
 */
export function assessFinancialInput(records: FinancialInputRecords): StepVerdict<FinancialInputObjects> {
  const { payment, approved_decision: decision } = records;
  const statement: CheckStatement = {
    subject: 'financial_input',
    expected: { currency: 'BRL', decision: 'APPROVED', amounts: 'equal_positive_safe_integers' },
  };
  const reasons = validateFinancialInput(payment, decision);
  if (isJsonObject(payment) && isJsonObject(decision)) {
    return verdictOf('FINANCIAL_INPUT', statement, reasons, { payment, decision });
  }
  return failed('FINANCIAL_INPUT', statement, [notObjectReason(payment, decision)]);
}

/** What A3 and A4 admit from the request: the declared inputs and the execution target. */
export interface AdmittedRequestInputs {
  readonly financial_inputs: DeclaredFinancialInputs;
  readonly target: ExecutionTarget;
}

/**
 * Step A4 (IDENTITY): every required identifier of the records is nonempty after trimming, and
 * the request names a variant exactly when it is a variant validation. Runs after A3 passed, so
 * the amounts, currency and decision are already the admitted ones.
 *
 * @example
 * const verdict = assessIdentityInput(objects, 'RUN', undefined);
 * if (verdict.passed) verdict.value.financial_inputs.payment_id; // 'pay-poc-001'
 */
export function assessIdentityInput(
  objects: FinancialInputObjects,
  kind: ExecutionKind,
  variant: JsonValue | undefined,
): StepVerdict<AdmittedRequestInputs> {
  const { payment, decision } = objects;
  const statement: CheckStatement = { subject: 'identity_input', expected: 'nonempty_trimmed_identifiers' };
  const target = targetOf(kind, variant);
  const reasons = [
    ...validateIdentityInput(payment, decision),
    ...(target === undefined ? [variantReason(kind, variant)] : []),
  ];
  const financialInputs: DeclaredFinancialInputs = {
    currency: 'BRL',
    payment_id: textOf(ownField(payment, 'payment_id')),
    captured_amount_minor: Number(ownField(payment, 'captured_amount_minor')),
    refund_request_id: textOf(ownField(decision, 'refund_request_id')),
    approved_amount_minor: Number(ownField(decision, 'approved_amount_minor')),
    decision: 'APPROVED',
  };
  return verdictOf('IDENTITY', statement, reasons, {
    financial_inputs: financialInputs,
    target: target ?? { kind: 'RUN' },
  });
}

// A variant validation deploys exactly one named variant; a run and a probe name none.
function targetOf(kind: ExecutionKind, variant: JsonValue | undefined): ExecutionTarget | undefined {
  if (kind !== 'VARIANT_VALIDATION') {
    return variant === undefined ? { kind } : undefined;
  }
  const named = VARIANT_IDS.find((candidate) => candidate === variant);
  return named === undefined ? undefined : { kind, variant: named };
}

function variantReason(kind: ExecutionKind, variant: JsonValue | undefined): StructuredReason {
  return admissionReason(
    'EXECUTION_VARIANT_INVALID',
    'BR-RUA-038',
    `a ${kind} request names variant ${describeJson(variant)}; expected ` +
      (kind === 'VARIANT_VALIDATION' ? '"conventional" or "durable"' : 'no variant'),
  );
}

function notObjectReason(payment: JsonValue, decision: JsonValue): StructuredReason {
  return admissionReason(
    'FINANCIAL_RECORD_NOT_OBJECT',
    SUBJECT,
    `payment is ${describeJson(payment)} and approved decision is ${describeJson(decision)}; expected two JSON objects`,
  );
}

function recordShapeReasons(
  recordType: 'payment' | 'approved_decision',
  record: JsonObject,
  members: ReadonlySet<string>,
): readonly StructuredReason[] {
  const reasons: StructuredReason[] = [];
  const schemaVersion = ownField(record, 'schema_version');
  const type = ownField(record, 'record_type');
  if (schemaVersion !== 1 || type !== recordType) {
    reasons.push(
      admissionReason(
        'FINANCIAL_RECORD_TYPE_INVALID',
        SUBJECT,
        `${recordType} has schema_version ${describeJson(schemaVersion)} and record_type ${describeJson(type)}; ` +
          `expected schema_version 1 and record_type "${recordType}"`,
      ),
    );
  }
  const extra = unexpectedField(record, members);
  if (extra !== undefined) {
    reasons.push(
      admissionReason(
        'FINANCIAL_RECORD_MEMBER_UNKNOWN',
        SUBJECT,
        `${recordType} has member ${boundedJsonText(extra)}; expected only ${[...members].join(', ')}`,
      ),
    );
  }
  return reasons;
}

function amountReasons(field: string, amount: JsonValue | undefined): readonly StructuredReason[] {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return [
      admissionReason(
        'AMOUNT_NOT_POSITIVE_INTEGER',
        SUBJECT,
        `${field} is ${describeJson(amount)}; expected a positive integer number of minor units`,
      ),
    ];
  }
  if (!Number.isSafeInteger(amount)) {
    return [
      admissionReason(
        'AMOUNT_UNSAFE',
        SUBJECT,
        `${field} is ${describeJson(amount)}; expected at most 9007199254740991`,
      ),
    ];
  }
  return [];
}

// Unequal amounts are judged only between two admissible amounts; a malformed one already failed.
function equalAmountReasons(
  captured: JsonValue | undefined,
  approved: JsonValue | undefined,
): readonly StructuredReason[] {
  if (!isAdmissibleAmount(captured) || !isAdmissibleAmount(approved) || captured === approved) {
    return [];
  }
  return [
    admissionReason(
      'AMOUNTS_UNEQUAL',
      SUBJECT,
      `captured_amount_minor ${describeJson(captured)} and approved_amount_minor ${describeJson(approved)} differ; ` +
        'expected equal amounts, because only full refunds are supported',
    ),
  ];
}

// A positive safe integer: the only amount `amountReasons` lets through.
function isAdmissibleAmount(amount: JsonValue | undefined): boolean {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
}

function currencyReasons(payment: JsonValue | undefined, decision: JsonValue | undefined): readonly StructuredReason[] {
  const reasons = [
    { field: 'payment.currency', value: payment },
    { field: 'approved_decision.currency', value: decision },
  ]
    .filter(({ value }) => value !== 'BRL')
    .map(({ field, value }) =>
      admissionReason('CURRENCY_NOT_BRL', SUBJECT, `${field} is ${describeJson(value)}; expected "BRL"`),
    );
  if (payment === decision) {
    return reasons;
  }
  return [
    ...reasons,
    admissionReason(
      'CURRENCY_MISMATCH',
      SUBJECT,
      `payment.currency ${describeJson(payment)} and approved_decision.currency ${describeJson(decision)} differ; expected one currency`,
    ),
  ];
}

function decisionReasons(decision: JsonValue | undefined): readonly StructuredReason[] {
  return decision === 'APPROVED'
    ? []
    : [
        admissionReason(
          'DECISION_NOT_APPROVED',
          SUBJECT,
          `approved_decision.decision is ${describeJson(decision)}; expected "APPROVED"`,
        ),
      ];
}

// Only two string identifiers are compared; a missing or non-string one is A4's identity problem.
function paymentLinkReasons(
  payment: JsonValue | undefined,
  decision: JsonValue | undefined,
): readonly StructuredReason[] {
  if (typeof payment !== 'string' || typeof decision !== 'string' || payment === decision) {
    return [];
  }
  return [
    admissionReason(
      'PAYMENT_ID_MISMATCH',
      SUBJECT,
      `approved_decision.payment_id ${boundedJsonText(decision)} differs from payment.payment_id ${boundedJsonText(payment)}; ` +
        'expected the decision to name the payment',
    ),
  ];
}

function identifierReason(field: string, value: JsonValue | undefined): StructuredReason | undefined {
  if (typeof value === 'string' && NONEMPTY_TRIMMED_PATTERN.test(value)) {
    return undefined;
  }
  return admissionReason(
    'IDENTIFIER_EMPTY',
    SUBJECT,
    `${field} is ${describeJson(value)}; expected a string that is nonempty after whitespace trimming, with no surrounding whitespace`,
  );
}

// A4 fails on any non-string identifier; the value it carries then is never frozen.
function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}
