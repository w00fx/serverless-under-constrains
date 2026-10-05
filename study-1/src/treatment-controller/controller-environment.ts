// The controller function's environment (design §9.4): the execution it serves and the two
// tables its IAM role may touch (§9.6: experiment-journal puts, control reads and the signal
// update). The caller-journal stream reaches it through the event source mapping, not a name.
// The parser is local because `refund-provider` is a same-layer module the controller may not
// import (design §5.4); timing is never configured here (OR-RUA-002).

import { isUuid4 } from '../record-contract/identifiers.ts';
import type { ExecutionIdentity, ExecutionKind, Result, Uuid4 } from '../record-contract/primitives.ts';
import { EXECUTION_KINDS } from '../record-contract/primitives.ts';

export const CONTROLLER_ENVIRONMENT_VARIABLES = {
  execution_kind: 'SUC_EXECUTION_KIND',
  execution_id: 'SUC_EXECUTION_ID',
  experiment_journal: 'SUC_TABLE_EXPERIMENT_JOURNAL',
  control: 'SUC_TABLE_CONTROL',
} as const;

/** The physical table names of the controller's two table roles. */
export interface ControllerTableNames {
  readonly experiment_journal: string;
  readonly control: string;
}

export interface ControllerEnvironment {
  readonly deployment: ExecutionIdentity;
  readonly tables: ControllerTableNames;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads the controller environment; the failure names every missing or malformed variable.
 *
 * @example
 * const environment = parseControllerEnvironment(process.env);
 * if (!environment.ok) throw new Error(environment.error);
 */
export function parseControllerEnvironment(env: Environment): Result<ControllerEnvironment, string> {
  const names = CONTROLLER_ENVIRONMENT_VARIABLES;
  const kind = env[names.execution_kind];
  const id = env[names.execution_id];
  const journal = env[names.experiment_journal];
  const control = env[names.control];
  const problems = [
    isExecutionKind(kind)
      ? undefined
      : `${names.execution_kind}=${JSON.stringify(kind)}; expected one of ${EXECUTION_KINDS.join(', ')}`,
    isUuid4(id)
      ? undefined
      : `${names.execution_id}=${JSON.stringify(id)}; expected a lowercase RFC 4122 version-4 UUID`,
    isTableName(journal)
      ? undefined
      : `${names.experiment_journal}=${JSON.stringify(journal)}; expected a non-empty table name`,
    isTableName(control) ? undefined : `${names.control}=${JSON.stringify(control)}; expected a non-empty table name`,
  ].filter((problem) => problem !== undefined);
  if (!isExecutionKind(kind) || !isUuid4(id) || !isTableName(journal) || !isTableName(control)) {
    return { ok: false, error: `controller environment invalid: ${problems.join('; ')}` };
  }
  return {
    ok: true,
    value: { deployment: deploymentOf(kind, id), tables: { experiment_journal: journal, control } },
  };
}

function deploymentOf(kind: ExecutionKind, id: Uuid4): ExecutionIdentity {
  switch (kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id };
  }
}

function isExecutionKind(value: string | undefined): value is ExecutionKind {
  return (EXECUTION_KINDS as readonly (string | undefined)[]).includes(value);
}

function isTableName(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}
