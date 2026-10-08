// The conventional caller function's environment (design §9.4): the execution it belongs to (a
// run or a variant validation; a transport probe has no variants, §9.2), the two tables its
// role may touch (§9.6), the provider version it invokes, and its variant id, which must be
// `conventional`.

import { isUuid4 } from '../record-contract/identifiers.ts';
import { describeJson } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, Result } from '../record-contract/primitives.ts';

export const CONVENTIONAL_ENVIRONMENT_VARIABLES = {
  execution_kind: 'SUC_EXECUTION_KIND',
  execution_id: 'SUC_EXECUTION_ID',
  caller_journal: 'SUC_TABLE_CALLER_JOURNAL',
  trial_registry: 'SUC_TABLE_TRIAL_REGISTRY',
  provider_function_name: 'SUC_PROVIDER_FUNCTION_NAME',
  provider_qualifier: 'SUC_PROVIDER_QUALIFIER',
  variant_id: 'SUC_VARIANT_ID',
} as const;

/** The executions that deploy variants: a run or a variant validation (design §9.2). */
export type VariantDeployment = Extract<ExecutionIdentity, { readonly execution_kind: 'RUN' | 'VARIANT_VALIDATION' }>;

export interface ConventionalEnvironment {
  readonly deployment: VariantDeployment;
  readonly caller_journal_table: string;
  readonly trial_registry_table: string;
  readonly provider_function_name: string;
  /** A published version number, never `$LATEST` or an alias (BR-RUA-053). */
  readonly provider_qualifier: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

type VariantExecutionKind = 'RUN' | 'VARIANT_VALIDATION';

// A Lambda version number: a positive integer without leading zeros.
const PROVIDER_VERSION_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Reads the conventional caller environment; the failure names every missing or malformed
 * variable with its value and the expected shape.
 *
 * @example
 * const environment = parseConventionalEnvironment(process.env);
 * if (!environment.ok) throw new Error(environment.error);
 */
export function parseConventionalEnvironment(env: Environment): Result<ConventionalEnvironment, string> {
  const names = CONVENTIONAL_ENVIRONMENT_VARIABLES;
  const kind = readVariable(env, names.execution_kind, isVariantExecutionKind, 'RUN or VARIANT_VALIDATION');
  const id = readVariable(env, names.execution_id, isUuid4, 'a lowercase RFC 4122 version-4 UUID');
  const journal = readVariable(env, names.caller_journal, isPresent, 'a non-empty table name');
  const registry = readVariable(env, names.trial_registry, isPresent, 'a non-empty table name');
  const functionName = readVariable(env, names.provider_function_name, isPresent, 'a non-empty function name');
  const qualifier = readVariable(env, names.provider_qualifier, isVersion, 'a published version number');
  const variant = readVariable(env, names.variant_id, isConventional, 'conventional');
  const reads = [kind, id, journal, registry, functionName, qualifier, variant];
  if (!kind.ok || !id.ok || !journal.ok || !registry.ok || !functionName.ok || !qualifier.ok || !variant.ok) {
    const problems = reads.flatMap((read) => (read.ok ? [] : [read.error]));
    return { ok: false, error: `conventional caller environment invalid: ${problems.join('; ')}` };
  }
  const deployment: VariantDeployment =
    kind.value === 'RUN'
      ? { execution_kind: 'RUN', run_id: id.value }
      : { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id.value };
  return {
    ok: true,
    value: {
      deployment,
      caller_journal_table: journal.value,
      trial_registry_table: registry.value,
      provider_function_name: functionName.value,
      provider_qualifier: qualifier.value,
    },
  };
}

// Reads one variable, narrowing it once; the failure names the variable, its value and the shape.
// (The probe caller's parser has the same shape; design §5.4 forbids same-layer imports.)
function readVariable<T extends string>(
  env: Environment,
  name: string,
  accepts: (value: string | undefined) => value is T,
  shape: string,
): Result<T, string> {
  const value = env[name];
  return accepts(value)
    ? { ok: true, value }
    : { ok: false, error: `${name} ${describeJson(value)}; expected ${shape}` };
}

function isVariantExecutionKind(value: string | undefined): value is VariantExecutionKind {
  return value === 'RUN' || value === 'VARIANT_VALIDATION';
}

function isConventional(value: string | undefined): value is 'conventional' {
  return value === 'conventional';
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function isVersion(value: string | undefined): value is string {
  return value !== undefined && PROVIDER_VERSION_PATTERN.test(value);
}
