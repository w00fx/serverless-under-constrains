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
  const kind = env[names.execution_kind];
  const id = env[names.execution_id];
  const table = env[names.caller_journal];
  const functionName = env[names.provider_function_name];
  const qualifier = env[names.provider_qualifier];
  const problems = [
    kind === 'TRANSPORT_PROBE'
      ? undefined
      : `${names.execution_kind}=${JSON.stringify(kind)}; expected TRANSPORT_PROBE`,
    isUuid4(id)
      ? undefined
      : `${names.execution_id}=${JSON.stringify(id)}; expected a lowercase RFC 4122 version-4 UUID`,
    isPresent(table) ? undefined : `${names.caller_journal}=${JSON.stringify(table)}; expected a non-empty table name`,
    isPresent(functionName)
      ? undefined
      : `${names.provider_function_name}=${JSON.stringify(functionName)}; expected a non-empty function name`,
    isVersion(qualifier)
      ? undefined
      : `${names.provider_qualifier}=${JSON.stringify(qualifier)}; expected a published version number`,
  ].filter((problem) => problem !== undefined);
  if (!isUuid4(id) || !isPresent(table) || !isPresent(functionName) || !isVersion(qualifier) || problems.length > 0) {
    return { ok: false, error: `probe caller environment invalid: ${problems.join('; ')}` };
  }
  return {
    ok: true,
    value: {
      deployment: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id },
      caller_journal_table: table,
      provider_function_name: functionName,
      provider_qualifier: qualifier,
    },
  };
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function isVersion(value: string | undefined): value is string {
  return value !== undefined && PROVIDER_VERSION_PATTERN.test(value);
}
