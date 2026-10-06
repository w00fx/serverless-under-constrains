// The probe caller function's environment (design §9.4): the transport probe it belongs to, the
// caller-journal table its IAM role may touch (§9.6), and the provider version it invokes. The
// execution kind must be TRANSPORT_PROBE: the construct exists only in probe stacks (§9.2).
// `SUC_VARIANT_ID` is not read: the probe is no variant.

import { isUuid4 } from '../record-contract/identifiers.ts';
import type { ExecutionIdentity, Result } from '../record-contract/primitives.ts';

export const PROBE_CALLER_ENVIRONMENT_VARIABLES = {
  execution_kind: 'SUC_EXECUTION_KIND',
  execution_id: 'SUC_EXECUTION_ID',
  caller_journal: 'SUC_TABLE_CALLER_JOURNAL',
  provider_function_name: 'SUC_PROVIDER_FUNCTION_NAME',
  provider_qualifier: 'SUC_PROVIDER_QUALIFIER',
} as const;

export interface ProbeCallerEnvironment {
  readonly deployment: ExecutionIdentity;
  readonly caller_journal_table: string;
  readonly provider_function_name: string;
  /** A published version number, never `$LATEST` or an alias (BR-RUA-053). */
  readonly provider_qualifier: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

// A Lambda version number: a positive integer without leading zeros.
const PROVIDER_VERSION_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Reads the probe caller environment; the failure names every missing or malformed variable.
 *
 * @example
 * const environment = parseProbeCallerEnvironment(process.env);
 * if (!environment.ok) throw new Error(environment.error);
 */
export function parseProbeCallerEnvironment(env: Environment): Result<ProbeCallerEnvironment, string> {
  const names = PROBE_CALLER_ENVIRONMENT_VARIABLES;
  const kind = readProbeVariable(env, names.execution_kind, isTransportProbeKind, 'TRANSPORT_PROBE');
  const id = readProbeVariable(env, names.execution_id, isUuid4, 'a lowercase RFC 4122 version-4 UUID');
  const table = readProbeVariable(env, names.caller_journal, isPresent, 'a non-empty table name');
  const functionName = readProbeVariable(env, names.provider_function_name, isPresent, 'a non-empty function name');
  const qualifier = readProbeVariable(env, names.provider_qualifier, isVersion, 'a published version number');
  if (!kind.ok || !id.ok || !table.ok || !functionName.ok || !qualifier.ok) {
    const problems = [kind, id, table, functionName, qualifier].flatMap((read) => (read.ok ? [] : [read.error]));
    return { ok: false, error: `probe caller environment invalid: ${problems.join('; ')}` };
  }
  return {
    ok: true,
    value: {
      deployment: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id.value },
      caller_journal_table: table.value,
      provider_function_name: functionName.value,
      provider_qualifier: qualifier.value,
    },
  };
}

// Reads one variable, narrowing it once; the failure names the variable, its value and the shape.
// (The controller's parser has the same shape; design §5.4 forbids importing it.)
function readProbeVariable<T extends string>(
  env: Environment,
  name: string,
  accepts: (value: string | undefined) => value is T,
  shape: string,
): Result<T, string> {
  const value = env[name];
  return accepts(value)
    ? { ok: true, value }
    : { ok: false, error: `${name}=${JSON.stringify(value)}; expected ${shape}` };
}

function isTransportProbeKind(value: string | undefined): value is 'TRANSPORT_PROBE' {
  return value === 'TRANSPORT_PROBE';
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function isVersion(value: string | undefined): value is string {
  return value !== undefined && PROVIDER_VERSION_PATTERN.test(value);
}
