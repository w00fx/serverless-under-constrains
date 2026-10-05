// Deterministic, readable scalar values for the group A canonical examples. Business values
// come from the spec's reference tables (OR-RUA-001..005); identities are fixed UUIDv4 strings so
// every example is reproducible byte for byte.

import type { MoneyDecimal, Sha256Hex, UtcMillis, Uuid4 } from '../../../../../src/record-contract/primitives.ts';

/** OR-RUA-001 financial fixture. */
export const FIXTURE = {
  payment_id: 'pay-poc-001',
  refund_request_id: 'ref-poc-001',
  amount_minor: 10000,
  currency: 'BRL',
} as const;

/** A lowercase UUIDv4 whose last group is the given number, e.g. `uuid(5)`. */
export function uuid(serial: number): Uuid4 {
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, '0')}` as Uuid4;
}

/** A 64-character lowercase hex digest made of one repeated hex digit, e.g. `digest('a')`. */
export function digest(hexDigit: string): Sha256Hex {
  return hexDigit.repeat(64) as Sha256Hex;
}

/** A millisecond UTC instant on the example day, e.g. `instant('12:00:00.000')`. */
export function instant(time: string): UtcMillis {
  return `2026-10-05T${time}Z` as UtcMillis;
}

/** A USD money decimal string, e.g. `usd('5.00')`. */
export function usd(amount: string): MoneyDecimal {
  return amount as MoneyDecimal;
}

export const IDS = {
  run: uuid(0x101),
  variantValidation: uuid(0x102),
  transportProbe: uuid(0x103),
  admissionAttempt: uuid(0x104),
  trial1: uuid(0x201),
  trial2: uuid(0x202),
  trial3: uuid(0x203),
  trial4: uuid(0x204),
  attempt: uuid(0x301),
  providerRequest: uuid(0x302),
  providerCall: uuid(0x303),
  providerTransaction: uuid(0x304),
} as const;

export const DIGESTS = {
  executionManifest: digest('a'),
  trialManifest: digest('b'),
  resourceManifest: digest('c'),
  payment: digest('d'),
  approvedDecision: digest('e'),
  lockfile: digest('f'),
  policy: digest('1'),
  scopeSnapshot: digest('2'),
  inventory: digest('3'),
  template: digest('4'),
  sourceProvenance: digest('5'),
  environmentInput: digest('6'),
  packageIndex: digest('7'),
  amendmentHead: digest('8'),
  schemaFile: digest('9'),
} as const;

export const ACCOUNT_ID = '012345678901';
export const COORDINATION_TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT_ID}:table/suc-study-1-coordination`;
export const COORDINATION_STACK_ID = `arn:aws:cloudformation:us-east-1:${ACCOUNT_ID}:stack/suc-study-1-coordination/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`;
export const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
export const TREE_SHA = '89abcdef0123456789abcdef0123456789abcdef';
