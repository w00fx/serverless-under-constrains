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
  const kind = readControllerVariable(
    env,
    names.execution_kind,
    isExecutionKind,
    `one of ${EXECUTION_KINDS.join(', ')}`,
  );
  const id = readControllerVariable(env, names.execution_id, isUuid4, 'a lowercase RFC 4122 version-4 UUID');
  const journal = readControllerVariable(env, names.experiment_journal, isTableName, 'a non-empty table name');
  const control = readControllerVariable(env, names.control, isTableName, 'a non-empty table name');
  if (!kind.ok || !id.ok || !journal.ok || !control.ok) {
    const problems = [kind, id, journal, control].flatMap((read) => (read.ok ? [] : [read.error]));
    return { ok: false, error: `controller environment invalid: ${problems.join('; ')}` };
  }
  return {
    ok: true,
    value: {
      deployment: deploymentOf(kind.value, id.value),
      tables: { experiment_journal: journal.value, control: control.value },
    },
  };
}

// Reads one variable, narrowing it once; the failure names the variable, its value and the shape.
function readControllerVariable<T extends string>(
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
