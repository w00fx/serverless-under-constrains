// The DynamoDB tables one admitted execution reads and writes (design §9.3, §9.7; BR-RUA-045,
// BR-RUA-053): the five run-owned tables carry the deterministic names the stack gives them
// (`tableName(execution_id, role)`, infra/ownership/resource-naming.ts), and the coordination table
// is the one the frozen environment admitted (`execution_manifest.environment.coordination_table_arn`).
// The names are known before the deploy, so the store adapter is bound at construction.

import { RUN_OWNED_TABLE_ROLES, tableName } from '../../infra/ownership/resource-naming.ts';
import type { RunOwnedTableRole } from '../../infra/ownership/resource-naming.ts';
import type { StoreTableNames } from '../durable-store/dynamodb-requests.ts';
import type { TableRole } from '../durable-store/item-store-port.ts';
import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import { executionIdOf } from '../evidence-package/package-layout.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import { coordinationTableName } from './environment-lease-reader.ts';

// The store names its logical tables in snake case; the stack names them in kebab case.
const STORE_ROLE: Readonly<Record<RunOwnedTableRole, TableRole>> = {
  ledger: 'ledger',
  'experiment-journal': 'experiment_journal',
  'caller-journal': 'caller_journal',
  control: 'control',
  'trial-registry': 'trial_registry',
};

/**
 * Every table of the execution, by store role, or why the frozen coordination table has no name.
 *
 * @example
 * executionTables(admitted); // ok({ ledger: 'suc1-3f1c2a9e-ledger', …, coordination: 'suc-coordination' })
 */
export function executionTables(admitted: AdmittedExecution): Result<StoreTableNames, StructuredReason> {
  const coordination = coordinationTableName(admitted.manifest.environment.coordination_table_arn);
  if (!coordination.ok) {
    return err({ ...coordination.error, subject: 'BR-RUA-045' });
  }
  const executionId = executionIdOf(admitted.identity);
  return ok({
    ...Object.fromEntries(RUN_OWNED_TABLE_ROLES.map((role) => [STORE_ROLE[role], tableName(executionId, role)])),
    coordination: coordination.value,
  });
}
