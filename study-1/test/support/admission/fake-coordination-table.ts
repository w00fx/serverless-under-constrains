// FakeCoordinationTable (design §12.2): the coordination-table port with a scripted description.
// It emulates `createCoordinationTableReader`: DescribeTable answers only for the table's own ARN
// (any other name fails as DynamoDB's ResourceNotFoundException does), and the description joins
// the key schema with the attribute types and the TTL status. Its conformance test runs the
// production adapter over a scripted DynamoDB endpoint.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type {
  CoordinationTableDescription,
  CoordinationTableReadPort,
  PortFailure,
  PortResult,
} from '../../../src/admission/admission-ports.ts';
import { CONFIGURED_TABLE } from './admission-fixtures.ts';

/**
 * The coordination table as scripted; the baseline configuration by default.
 *
 * @example
 * const table = new FakeCoordinationTable({ time_to_live_status: 'ENABLED' });
 * await table.readCoordinationTable(TABLE_ARN); // { ok: true, value: { time_to_live_status: 'ENABLED', … } }
 */
export class FakeCoordinationTable implements CoordinationTableReadPort {
  readonly #description: CoordinationTableDescription;
  readonly #requested: string[] = [];
  #failure: PortFailure | undefined;

  constructor(overrides: Partial<CoordinationTableDescription> = {}) {
    this.#description = { ...CONFIGURED_TABLE, ...overrides };
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  /** Every table ARN read so far. */
  requested(): readonly string[] {
    return [...this.#requested];
  }

  readCoordinationTable(tableArn: string): PortResult<CoordinationTableDescription> {
    this.#requested.push(tableArn);
    if (this.#failure !== undefined) {
      return Promise.resolve(err(this.#failure));
    }
    if (tableArn !== this.#description.table_arn) {
      return Promise.resolve(
        err({
          code: 'ResourceNotFoundException',
          detail: `Requested resource not found: Table: ${tableArn} not found`,
        }),
      );
    }
    return Promise.resolve(ok(this.#description));
  }
}
