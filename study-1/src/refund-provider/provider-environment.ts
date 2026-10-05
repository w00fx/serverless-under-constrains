// The provider function's environment (design §9.4): the execution it belongs to and the three
// tables its IAM role may touch (§9.6). Timing is never configured here; it is code (OR-RUA-002).

import { isUuid4 } from '../record-contract/identifiers.ts';
import type { ExecutionIdentity, ExecutionKind, Result } from '../record-contract/primitives.ts';
import { EXECUTION_KINDS } from '../record-contract/primitives.ts';
import { executionIdentityOf } from './execution-identity-fields.ts';

export const PROVIDER_ENVIRONMENT_VARIABLES = {
  execution_kind: 'SUC_EXECUTION_KIND',
  execution_id: 'SUC_EXECUTION_ID',
  ledger: 'SUC_TABLE_LEDGER',
  experiment_journal: 'SUC_TABLE_EXPERIMENT_JOURNAL',
  control: 'SUC_TABLE_CONTROL',
} as const;

const TABLE_ROLES = ['ledger', 'experiment_journal', 'control'] as const;

/** The physical table names of the provider's three table roles. */
export type ProviderTableNames = Readonly<Record<(typeof TABLE_ROLES)[number], string>>;

export interface ProviderEnvironment {
  readonly deployment: ExecutionIdentity;
  readonly tables: ProviderTableNames;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads the provider environment; the failure names every missing or malformed variable.
 *
 * @example
 * const environment = parseProviderEnvironment(process.env);
 * if (!environment.ok) throw new Error(environment.error);
 */
export function parseProviderEnvironment(env: Environment): Result<ProviderEnvironment, string> {
  const names = PROVIDER_ENVIRONMENT_VARIABLES;
  const kind = env[names.execution_kind];
  const id = env[names.execution_id];
  const problems: string[] = [];
  if (!isExecutionKind(kind)) {
    problems.push(`${names.execution_kind}=${JSON.stringify(kind)}; expected one of ${EXECUTION_KINDS.join(', ')}`);
  }
  if (!isUuid4(id)) {
    problems.push(`${names.execution_id}=${JSON.stringify(id)}; expected a lowercase RFC 4122 version-4 UUID`);
  }
  const tables: Partial<Record<(typeof TABLE_ROLES)[number], string>> = {};
  for (const role of TABLE_ROLES) {
    const value = env[names[role]];
    if (value === undefined || value.trim() === '') {
      problems.push(`${names[role]}=${JSON.stringify(value)}; expected a non-empty table name`);
      continue;
    }
    tables[role] = value;
  }
  if (problems.length > 0 || !isExecutionKind(kind) || !isUuid4(id)) {
    return { ok: false, error: `provider environment invalid: ${problems.join('; ')}` };
  }
  // Every role was checked above; the cast restates it.
  return { ok: true, value: { deployment: executionIdentityOf(kind, id), tables: tables as ProviderTableNames } };
}

function isExecutionKind(value: string | undefined): value is ExecutionKind {
  return (EXECUTION_KINDS as readonly (string | undefined)[]).includes(value);
}
