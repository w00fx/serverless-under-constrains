// What a billing line must match to be attributable (BR-RUA-047, design §8.17): the frozen 12-digit
// usage account, an exact resource-manifest identity, the activated `suc:run_id` tag equal to the
// execution id (D-07: that tag carries the execution id for all three kinds), a run-owned
// product/operation pair, and the attribution window. The caller assembles these from the frozen
// package; this module only checks them and fixes their lookup form, so correlation is pure set
// membership and never interprets an identity.

import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { NONEMPTY_TRIMMED_PATTERN, err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import { isUtcMillis } from '../record-contract/timestamps.ts';
import { REASON_SAMPLE_LIMIT } from './unverified-reasons.ts';
import { attributionWindow } from './usage-window.ts';
import type { UsageInterval } from './usage-window.ts';

/** One run-owned service and the operations of it that the run's resources perform. */
export interface ChargeAllowlistEntry {
  readonly product_code: string;
  readonly operations: readonly string[];
}

/** The attribution inputs as the caller supplies them. */
export interface AttributionContextInput {
  readonly identity: ExecutionIdentity;
  /** The frozen 12-digit account of the execution manifest. */
  readonly account_id: string;
  /** Every resource identity the resource manifest proves run-owned, as CUR writes resource ids. */
  readonly resource_identities: readonly string[];
  readonly charge_allowlist: readonly ChargeAllowlistEntry[];
  readonly first_mutation_at: string;
  readonly cleanup_terminal_at: string;
}

/** The checked attribution inputs in lookup form. */
export interface AttributionContext {
  readonly account_id: string;
  /** The value the activated `suc:run_id` tag must carry. */
  readonly ownership_tag_value: Uuid4;
  readonly resource_identities: ReadonlySet<string>;
  /** Product code to its run-owned operations. */
  readonly charge_allowlist: ReadonlyMap<string, ReadonlySet<string>>;
  readonly window: UsageInterval;
}

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
/** The last instant whose ceiling hour is still a four-digit-year timestamp. */
const LATEST_CLEANUP_TERMINAL_AT = Date.parse('9999-12-31T23:00:00.000Z');

/**
 * Checks the attribution inputs and returns them in lookup form, or every reason they are unusable.
 *
 * @example
 * const context = parseAttributionContext({ identity: { execution_kind: 'RUN', run_id }, account_id: '123456789012',
 *   resource_identities: [providerArn], charge_allowlist: [{ product_code: 'AWSLambda', operations: ['Invoke'] }],
 *   first_mutation_at: '2026-10-05T10:17:03.120Z', cleanup_terminal_at: '2026-10-05T11:02:00.000Z' });
 */
export function parseAttributionContext(
  input: AttributionContextInput,
): Result<AttributionContext, readonly StructuredReason[]> {
  const tagValue = ownershipTagValue(input.identity);
  const problems = [
    ...(ACCOUNT_ID_PATTERN.test(input.account_id)
      ? []
      : [`account_id ${boundedJsonText(input.account_id)} is not a 12-digit account id`]),
    ...(isUuid4(tagValue) ? [] : [`execution id ${boundedJsonText(tagValue)} is not a lowercase UUIDv4`]),
    ...nonEmptyProblems('resource_identities', input.resource_identities),
    ...input.charge_allowlist.flatMap(allowlistProblems),
    ...intervalProblems(input.first_mutation_at, input.cleanup_terminal_at),
  ];
  if (problems.length > 0) {
    return err(listedProblems(problems).map(contextReason));
  }
  return ok({
    account_id: input.account_id,
    // Checked above: a non-UUIDv4 execution id is one of the problems.
    ownership_tag_value: tagValue as Uuid4,
    resource_identities: new Set(input.resource_identities),
    charge_allowlist: allowlistMap(input.charge_allowlist),
    window: attributionWindow(input.first_mutation_at as UtcMillis, input.cleanup_terminal_at as UtcMillis),
  });
}

function ownershipTagValue(identity: ExecutionIdentity): string {
  switch (identity.execution_kind) {
    case 'RUN':
      return identity.run_id;
    case 'TRANSPORT_PROBE':
      return identity.transport_probe_id;
    case 'VARIANT_VALIDATION':
      return identity.variant_validation_id;
  }
}

function nonEmptyProblems(field: string, values: readonly string[]): readonly string[] {
  return values
    .filter((value) => !NONEMPTY_TRIMMED_PATTERN.test(value))
    .map((value) => `${field} entry ${boundedJsonText(value)} is empty or has edge whitespace`);
}

function allowlistProblems(entry: ChargeAllowlistEntry): readonly string[] {
  const product = NONEMPTY_TRIMMED_PATTERN.test(entry.product_code)
    ? []
    : [`charge_allowlist product_code ${boundedJsonText(entry.product_code)} is empty or has edge whitespace`];
  const none =
    entry.operations.length === 0
      ? [`charge_allowlist entry ${boundedJsonText(entry.product_code)} lists no operation`]
      : [];
  return [...product, ...none, ...nonEmptyProblems('charge_allowlist operations', entry.operations)];
}

function intervalProblems(firstMutationAt: string, cleanupTerminalAt: string): readonly string[] {
  if (!isUtcMillis(firstMutationAt) || !isUtcMillis(cleanupTerminalAt)) {
    return [
      `first_mutation_at ${boundedJsonText(firstMutationAt)} or cleanup_terminal_at ${boundedJsonText(cleanupTerminalAt)} is not a UTC millis timestamp`,
    ];
  }
  const first = Date.parse(firstMutationAt);
  const terminal = Date.parse(cleanupTerminalAt);
  if (terminal < first || terminal > LATEST_CLEANUP_TERMINAL_AT) {
    return [
      `cleanup_terminal_at ${cleanupTerminalAt} precedes first_mutation_at ${firstMutationAt} or is past 9999-12-31T23:00:00.000Z`,
    ];
  }
  return [];
}

function allowlistMap(entries: readonly ChargeAllowlistEntry[]): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    const operations = map.get(entry.product_code) ?? new Set<string>();
    entry.operations.forEach((operation) => operations.add(operation));
    map.set(entry.product_code, operations);
  }
  return map;
}

// The identity and allowlist lists are caller-sized, so the refusal names the first few problems and
// counts the rest (A-12: findings must not scale with input).
function listedProblems(problems: readonly string[]): readonly string[] {
  const unlisted = problems.length - REASON_SAMPLE_LIMIT;
  const listed = problems.slice(0, REASON_SAMPLE_LIMIT);
  return unlisted > 0 ? [...listed, `${String(unlisted)} more problem(s) not listed`] : listed;
}

function contextReason(problem: string): StructuredReason {
  return {
    code: 'INVALID_ATTRIBUTION_CONTEXT',
    subject: 'BR-RUA-047',
    detail: `${problem}; expected a 12-digit account, a UUIDv4 execution id, non-empty trimmed identities and operations, and first_mutation_at <= cleanup_terminal_at as YYYY-MM-DDTHH:mm:ss.SSSZ`,
  };
}
