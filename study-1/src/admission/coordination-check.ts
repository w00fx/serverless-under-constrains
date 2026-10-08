// Admission step A8 (design §10.1, §9.1; BR-RUA-045, BR-RUA-041): the baseline coordination
// table and its lease item.
// COORDINATION_CONFIGURATION: the described table must be the one the environment input names,
// ACTIVE, keyed `pk` (HASH, S) and `sk` (RANGE, S), deletion-protected, with TTL disabled (a TTL
// deletion would look like a release), and its schema version must be the one this source writes.
// An unreadable or undecodable lease item is a configuration problem too.
// SAFETY: a lease item that is held or that requires recovery is a conflicting owner, whatever
// its `expires_at` says: expiry is informational and never establishes release.

import { boundedText } from '../record-contract/json-value.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { EnvironmentInput } from '../record-contract/records/group-a/environment_input.ts';
import { COORDINATION_SCHEMA_VERSION, describeHolder, isLeaseAvailable } from '../coordination-lease/lease-item.ts';
import type { LeaseItem } from '../coordination-lease/lease-item.ts';
import type { LeaseReadFailure } from '../coordination-lease/lease-store-port.ts';
import type { CoordinationKeyAttribute, CoordinationTableDescription, PortFailure } from './admission-ports.ts';
import { admissionReason, portFailureReason } from './admission-reason.ts';
import { failed, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-045';
const EXPECTED_KEYS: readonly CoordinationKeyAttribute[] = [
  { attribute_name: 'pk', key_type: 'HASH', attribute_type: 'S' },
  { attribute_name: 'sk', key_type: 'RANGE', attribute_type: 'S' },
];

/** The coordination readings of step A8. */
export interface CoordinationReadings {
  readonly table: Result<CoordinationTableDescription, PortFailure>;
  readonly lease: Result<LeaseItem | undefined, LeaseReadFailure>;
}

/**
 * Step A8: configuration first, then the conflicting-owner check.
 *
 * @example
 * assessCoordination({ table: ok(description), lease: ok(undefined) }, environment).passed; // true
 */
export function assessCoordination(readings: CoordinationReadings, environment: EnvironmentInput): StepVerdict<null> {
  const statement: CheckStatement = {
    subject: 'coordination',
    expected: {
      table_arn: environment.coordination_table_arn,
      coordination_schema_version: COORDINATION_SCHEMA_VERSION,
      lease: 'absent_or_released',
    },
    observed: { lease: leaseState(readings.lease) },
  };
  const [configuration, ...more] = [
    ...schemaVersionReasons(environment.expected_coordination_schema_version),
    ...tableReasons(readings.table, environment.coordination_table_arn),
  ];
  const lease = readings.lease;
  if (!lease.ok) {
    const unreadable = portFailureReason('LEASE_UNREADABLE', SUBJECT, 'the lease item read', lease.error);
    return failed(
      'COORDINATION_CONFIGURATION',
      statement,
      configuration === undefined ? [unreadable] : [configuration, ...more, unreadable],
    );
  }
  if (configuration !== undefined) {
    return failed('COORDINATION_CONFIGURATION', statement, [configuration, ...more]);
  }
  const item = lease.value;
  if (item !== undefined && !isLeaseAvailable(item)) {
    return failed('SAFETY', statement, [
      admissionReason(
        'CONFLICTING_LEASE',
        SUBJECT,
        `the lease is ${boundedText(describeHolder(item))}; expected no item or a RELEASED one`,
      ),
    ]);
  }
  return passed(null, statement);
}

function leaseState(lease: Result<LeaseItem | undefined, LeaseReadFailure>): string {
  if (!lease.ok) {
    return 'unreadable';
  }
  return lease.value === undefined ? 'absent' : lease.value.lease_status;
}

function schemaVersionReasons(expected: number): readonly StructuredReason[] {
  return expected === COORDINATION_SCHEMA_VERSION
    ? []
    : [
        admissionReason(
          'COORDINATION_SCHEMA_VERSION_MISMATCH',
          SUBJECT,
          `the environment input expects coordination schema version ${String(expected)}; expected ${String(COORDINATION_SCHEMA_VERSION)}, the version this source writes`,
        ),
      ];
}

function tableReasons(
  reading: Result<CoordinationTableDescription, PortFailure>,
  tableArn: string,
): readonly StructuredReason[] {
  if (!reading.ok) {
    return [portFailureReason('COORDINATION_TABLE_UNREADABLE', SUBJECT, 'DescribeTable', reading.error)];
  }
  const table = reading.value;
  const problems: readonly (readonly [boolean, string])[] = [
    [table.table_arn === tableArn, `table ARN is ${boundedText(table.table_arn)}; expected ${tableArn}`],
    [table.table_status === 'ACTIVE', `table status is ${boundedText(table.table_status)}; expected ACTIVE`],
    [
      sameKeySchema(table.key_schema),
      `key schema is ${describeKeys(table.key_schema)}; expected ${describeKeys(EXPECTED_KEYS)}`,
    ],
    [table.deletion_protection_enabled, 'deletion protection is disabled; expected enabled'],
    [
      table.time_to_live_status === 'DISABLED',
      `TimeToLiveStatus is ${boundedText(table.time_to_live_status)}; expected DISABLED, since TTL deletion never establishes release`,
    ],
  ];
  return problems
    .filter(([holds]) => !holds)
    .map(([, detail]) => admissionReason('COORDINATION_TABLE_INVALID', SUBJECT, detail));
}

function sameKeySchema(keys: readonly CoordinationKeyAttribute[]): boolean {
  return describeKeys(keys) === describeKeys(EXPECTED_KEYS);
}

function describeKeys(keys: readonly CoordinationKeyAttribute[]): string {
  const described = keys.map((key) => `${key.attribute_name} ${key.key_type} ${key.attribute_type ?? 'undefined'}`);
  return boundedText(`[${described.join(', ')}]`);
}
