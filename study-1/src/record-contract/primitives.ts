// Shared primitives of the record contract (design §5.2). Every feature imports these
// instead of redefining identity, time or outcome vocabularies.
//
// Value vocabularies are `as const` tuples because erasable-syntax-only TypeScript has no
// enums (toolchain research §1); each union type is derived from its tuple so the runtime
// list and the type can never drift apart.

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Canonical lowercase RFC 4122 version-4 UUID (BR-RUA-033). */
export type Uuid4 = Brand<string, 'Uuid4'>;
/** Lowercase hexadecimal SHA-256 digest over exact stored bytes (BR-RUA-033). */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;
/** UTC timestamp `YYYY-MM-DDTHH:mm:ss.SSSZ` with exactly millisecond precision (BR-RUA-033). */
export type UtcMillis = Brand<string, 'UtcMillis'>;
/** Nonnegative canonical base-10 integer string: aggregates and elapsed nanoseconds. */
export type DecimalString = Brand<string, 'DecimalString'>;
/** Canonical signed base-10 integer string (`0` is never written as `-0`). */
export type SignedDecimalString = Brand<string, 'SignedDecimalString'>;
/** Nonnegative decimal money amount, used for billing USD only. */
export type MoneyDecimal = Brand<string, 'MoneyDecimal'>;

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface WallClock {
  now(): Date;
}
/** Source-local monotonic clock; absolute values are never serialized (BR-RUA-033). */
export interface MonotonicClock {
  nowNs(): bigint;
}
export interface UuidSource {
  next(): Uuid4;
}
export interface TimerHandle {
  cancel(): void;
}
export interface TimerScheduler {
  schedule(delayMs: number, callback: () => void): TimerHandle;
}
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const EXECUTION_KINDS = ['RUN', 'TRANSPORT_PROBE', 'VARIANT_VALIDATION'] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

export type ExecutionIdentity =
  | { readonly execution_kind: 'RUN'; readonly run_id: Uuid4 }
  | { readonly execution_kind: 'TRANSPORT_PROBE'; readonly transport_probe_id: Uuid4 }
  | { readonly execution_kind: 'VARIANT_VALIDATION'; readonly variant_validation_id: Uuid4 };

export const VARIANT_IDS = ['conventional', 'durable'] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

export const SCENARIOS = ['CONTROL', 'COMMIT_THEN_TIMEOUT'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const GATE_VALUES = ['verified', 'invalid', 'unverified', 'not_applicable'] as const;
export type GateValue = (typeof GATE_VALUES)[number];

export const RULE_OUTCOMES = ['pass', 'fail', 'indeterminate', 'not_applicable'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/**
 * A machine-readable reason. `code` is UPPER_SNAKE and closed per producer; `detail`
 * names the offending value and the expected shape (clean-code rule).
 */
export interface StructuredReason {
  readonly code: string;
  readonly subject: string;
  readonly artifact_path?: string;
  readonly event_id?: Uuid4;
  readonly detail: string;
}

/**
 * Builds a successful `Result`.
 *
 * @example
 * const r = ok(42); // { ok: true, value: 42 }
 */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/**
 * Builds a failed `Result`.
 *
 * @example
 * const r = err({ code: 'X', subject: 's', detail: 'd' }); // { ok: false, error: {...} }
 */
export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
