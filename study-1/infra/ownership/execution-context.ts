// The synthesis context of one execution (design §9.8 S1): admission writes it as JSON and
// passes its path with `--context suc:execution=<path>`. It carries the execution id (names,
// tags, environment) but never the execution-manifest digest, which would be circular
// (design §9.1). Account and Region are explicit, so synthesis never performs lookups.

import { readFileSync } from 'node:fs';

import type { IConstruct } from 'constructs';

import { isUuid4 } from '../../src/record-contract/identifiers.ts';
import { EXECUTION_KINDS, VARIANT_IDS } from '../../src/record-contract/primitives.ts';
import type { ExecutionKind, Uuid4, UtcMillis, VariantId } from '../../src/record-contract/primitives.ts';
import { isUtcMillis } from '../../src/record-contract/timestamps.ts';

export const EXECUTION_CONTEXT_KEY = 'suc:execution';
export const STUDY_REGION = 'us-east-1';

export interface ExecutionSynthContext {
  readonly execution_kind: ExecutionKind;
  readonly execution_id: Uuid4;
  /** The frozen 12-digit account string (an account id is a string, never a number). */
  readonly account: string;
  readonly region: typeof STUDY_REGION;
  readonly admitted_at: UtcMillis;
  /** The total-time target of the execution kind, which sets `suc:expires_at`. */
  readonly total_target_ms: number;
  /** Present exactly for a variant validation: the single variant it deploys. */
  readonly variant_id?: VariantId;
}

const ACCOUNT_PATTERN = /^\d{12}$/;
const FIELDS = ['execution_kind', 'execution_id', 'account', 'region', 'admitted_at', 'total_target_ms', 'variant_id'];

/**
 * Validates a parsed context, throwing one error that lists every problem with the offending
 * value and the expected shape.
 *
 * @example
 * const context = parseExecutionSynthContext(JSON.parse(text));
 */
export function parseExecutionSynthContext(value: unknown): ExecutionSynthContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`execution context is ${JSON.stringify(value)}; expected a JSON object`);
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const problems = [...unknownFieldProblems(fields), ...identityProblems(fields), ...placementProblems(fields)];
  if (problems.length > 0) {
    throw new Error(`invalid execution context: ${problems.join('; ')}`);
  }
  return fields as unknown as ExecutionSynthContext;
}

/**
 * Reads the context file named by the `suc:execution` CDK context key of a construct tree.
 *
 * @example
 * const context = readExecutionSynthContext(app);
 */
export function readExecutionSynthContext(scope: IConstruct): ExecutionSynthContext {
  const path: unknown = scope.node.tryGetContext(EXECUTION_CONTEXT_KEY);
  if (typeof path !== 'string' || path === '') {
    throw new Error(
      `CDK context ${EXECUTION_CONTEXT_KEY} is ${JSON.stringify(path)}; expected the path of execution-context.json`,
    );
  }
  return parseExecutionSynthContext(JSON.parse(readFileSync(path, 'utf8')));
}

function unknownFieldProblems(fields: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(fields)
    .filter((key) => !FIELDS.includes(key))
    .map((key) => `unknown field ${JSON.stringify(key)}; expected only ${FIELDS.join(', ')}`);
}

function identityProblems(fields: Readonly<Record<string, unknown>>): readonly string[] {
  const problems: string[] = [];
  const kind = fields['execution_kind'];
  if (!(EXECUTION_KINDS as readonly unknown[]).includes(kind)) {
    problems.push(`execution_kind ${JSON.stringify(kind)}; expected one of ${EXECUTION_KINDS.join(', ')}`);
  }
  if (!isUuid4(fields['execution_id'])) {
    problems.push(`execution_id ${JSON.stringify(fields['execution_id'])}; expected a lowercase UUIDv4`);
  }
  const variant = fields['variant_id'];
  const wantsVariant = kind === 'VARIANT_VALIDATION';
  if (wantsVariant && !(VARIANT_IDS as readonly unknown[]).includes(variant)) {
    problems.push(`variant_id ${JSON.stringify(variant)}; a variant validation needs one of ${VARIANT_IDS.join(', ')}`);
  }
  if (!wantsVariant && variant !== undefined) {
    problems.push(`variant_id ${JSON.stringify(variant)}; only a VARIANT_VALIDATION context carries a variant`);
  }
  return problems;
}

function placementProblems(fields: Readonly<Record<string, unknown>>): readonly string[] {
  const problems: string[] = [];
  const account = fields['account'];
  if (typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) {
    problems.push(`account ${JSON.stringify(account)}; expected a 12-digit account id string`);
  }
  if (fields['region'] !== STUDY_REGION) {
    problems.push(`region ${JSON.stringify(fields['region'])}; expected "${STUDY_REGION}"`);
  }
  if (!isUtcMillis(fields['admitted_at'])) {
    problems.push(`admitted_at ${JSON.stringify(fields['admitted_at'])}; expected YYYY-MM-DDTHH:mm:ss.SSSZ`);
  }
  const target = fields['total_target_ms'];
  if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) {
    problems.push(`total_target_ms ${JSON.stringify(target)}; expected a positive safe integer`);
  }
  return problems;
}
