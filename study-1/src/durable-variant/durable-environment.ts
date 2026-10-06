// The Durable caller function's environment (design §9.4): the execution it belongs to (a run or
// a variant validation; a transport probe has no variants, §9.2), the two tables its role may
// touch (§9.6), the provider version it invokes, and its variant id, which must be `durable`.
// The retry delay is no variable: it is the OR-RUA-002 code constant (DEPLOYED_DURABLE_RETRY).

import { isUuid4 } from '../record-contract/identifiers.ts';
import { describeJson } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, Result } from '../record-contract/primitives.ts';

export const DURABLE_ENVIRONMENT_VARIABLES = {
  execution_kind: 'SUC_EXECUTION_KIND',
  execution_id: 'SUC_EXECUTION_ID',
  caller_journal: 'SUC_TABLE_CALLER_JOURNAL',
  trial_registry: 'SUC_TABLE_TRIAL_REGISTRY',
  provider_function_name: 'SUC_PROVIDER_FUNCTION_NAME',
  provider_qualifier: 'SUC_PROVIDER_QUALIFIER',
  variant_id: 'SUC_VARIANT_ID',
} as const;

/** The executions that deploy the Durable variant: a run or a variant validation (design §9.2). */
export type DurableDeployment = Extract<ExecutionIdentity, { readonly execution_kind: 'RUN' | 'VARIANT_VALIDATION' }>;

export interface DurableEnvironment {
  readonly deployment: DurableDeployment;
  readonly caller_journal_table: string;
  readonly trial_registry_table: string;
  readonly provider_function_name: string;
  /** A published version number, never `$LATEST` or an alias (BR-RUA-053). */
  readonly provider_qualifier: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

type DurableExecutionKind = DurableDeployment['execution_kind'];

// A Lambda version number: a positive integer without leading zeros.
const PROVIDER_VERSION_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Reads the Durable caller environment; the failure names every missing or malformed variable
 * with its value and the expected shape. Reads only own properties of `env`.
 *
 * @example
 * const environment = parseDurableEnvironment(process.env);
 * if (!environment.ok) throw new Error(environment.error);
 */
export function parseDurableEnvironment(env: Environment): Result<DurableEnvironment, string> {
  const names = DURABLE_ENVIRONMENT_VARIABLES;
  const kind = readVariable(env, names.execution_kind, isDurableExecutionKind, 'RUN or VARIANT_VALIDATION');
  const id = readVariable(env, names.execution_id, isUuid4, 'a lowercase RFC 4122 version-4 UUID');
  const journal = readVariable(env, names.caller_journal, isPresent, 'a non-empty table name');
  const registry = readVariable(env, names.trial_registry, isPresent, 'a non-empty table name');
  const functionName = readVariable(env, names.provider_function_name, isPresent, 'a non-empty function name');
  const qualifier = readVariable(env, names.provider_qualifier, isVersion, 'a published version number');
  const variant = readVariable(env, names.variant_id, isDurable, 'durable');
  const reads = [kind, id, journal, registry, functionName, qualifier, variant];
  if (!kind.ok || !id.ok || !journal.ok || !registry.ok || !functionName.ok || !qualifier.ok || !variant.ok) {
    const problems = reads.flatMap((read) => (read.ok ? [] : [read.error]));
    return { ok: false, error: `durable caller environment invalid: ${problems.join('; ')}` };
  }
  const deployment: DurableDeployment =
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
// (The conventional and probe caller parsers have the same shape; design §5.4 forbids same-layer
// imports outside `conventional-variant/request-state/`.)
function readVariable<T extends string>(
  env: Environment,
  name: string,
  accepts: (value: string | undefined) => value is T,
  shape: string,
): Result<T, string> {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return accepts(value)
    ? { ok: true, value }
    : { ok: false, error: `${name} ${describeJson(value)}; expected ${shape}` };
}

function isDurableExecutionKind(value: string | undefined): value is DurableExecutionKind {
  return value === 'RUN' || value === 'VARIANT_VALIDATION';
}

function isDurable(value: string | undefined): value is 'durable' {
  return value === 'durable';
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function isVersion(value: string | undefined): value is string {
  return value !== undefined && PROVIDER_VERSION_PATTERN.test(value);
}
