// Admission's lease read (design §10.1 A8, BR-RUA-045) against the coordination table the
// operator's environment input names. Admission's ports are built before the input is read, and
// its `lease.read()` takes no table, so this reader resolves the table from the same input file at
// read time and only then opens the lease store. An input that does not name a table is a read
// failure naming the file; admission records it as an unreadable lease (`LEASE_UNREADABLE`).

import { validateEnvironmentInput } from '../admission/environment-input.ts';
import type { LeaseReadPort } from '../admission/admission-ports.ts';
import type { LeaseItem } from '../coordination-lease/lease-item.ts';
import type { LeaseReadFailure } from '../coordination-lease/lease-store-port.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { InputFileReader } from './admit-commands.ts';

// The schema pins the ARN shape; the name is everything after `:table/`.
const TABLE_ARN = /^arn:aws:dynamodb:[^:]+:\d{12}:table\/([A-Za-z0-9_.-]{3,255})$/;

export interface EnvironmentLeaseReaderDeps {
  readonly inputs: InputFileReader;
  /** Absolute path of the environment input file of this admission. */
  readonly environmentPath: string;
  readonly validator: RecordValidator;
  /** Opens the lease store of one coordination table (production: the DynamoDB lease store). */
  readonly openLease: (tableName: string) => LeaseReadPort;
}

/**
 * The lease of the table the environment input names.
 *
 * @example
 * await new EnvironmentLeaseReader({ inputs, environmentPath, validator, openLease }).read();
 */
export class EnvironmentLeaseReader implements LeaseReadPort {
  readonly #deps: EnvironmentLeaseReaderDeps;

  constructor(deps: EnvironmentLeaseReaderDeps) {
    this.#deps = deps;
  }

  async read(): Promise<Result<LeaseItem | undefined, LeaseReadFailure>> {
    const table = await this.#tableName();
    return table.ok ? this.#deps.openLease(table.value).read() : table;
  }

  async #tableName(): Promise<Result<string, LeaseReadFailure>> {
    const path = this.#deps.environmentPath;
    const bytes = await this.#deps.inputs.readBytes(path);
    if (!bytes.ok) {
      return err(unnamed(path, `${bytes.error.code}: ${bytes.error.detail}`));
    }
    const parsed = parseJsonDocument(bytes.value);
    const input = parsed.ok ? validateEnvironmentInput(parsed.value, this.#deps.validator) : parsed;
    if (!input.ok) {
      return err(unnamed(path, 'not a valid environment_input record'));
    }
    return coordinationTableName(input.value.coordination_table_arn);
  }
}

/**
 * The table name of a coordination table ARN.
 *
 * @example
 * coordinationTableName('arn:aws:dynamodb:us-east-1:012345678901:table/suc-coordination'); // ok('suc-coordination')
 */
export function coordinationTableName(arn: string): Result<string, LeaseReadFailure> {
  const name = TABLE_ARN.exec(arn)?.[1];
  return name === undefined
    ? err({
        code: 'COORDINATION_TABLE_UNNAMED',
        detail: `coordination_table_arn ${boundedJsonText(arn)} names no table; expected arn:aws:dynamodb:<region>:<account>:table/<name>`,
      })
    : ok(name);
}

function unnamed(path: string, problem: string): LeaseReadFailure {
  return {
    code: 'COORDINATION_TABLE_UNNAMED',
    detail: `${boundedJsonText(path)} names no coordination table (${boundedText(problem)}); expected a readable environment_input`,
  };
}
