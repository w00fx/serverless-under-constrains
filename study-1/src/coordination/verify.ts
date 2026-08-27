import {
  ALLOWED_REGION,
  buildCoordinationTableArn,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  isExpectedCoordinationSchemaVersion,
  isFrozenCoordinationTableArn,
  isReadyCoordinationStackStatus,
  isTwelveDigitAccountId,
  READY_COORDINATION_STACK_STATUSES,
} from "./identity.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  CoordinationCommandResult,
  CoordinationRejection,
  StackObservation,
  TableObservation,
} from "./types.ts";

export async function verifyCoordination(
  request: CoordinationCommandRequest,
  cloud: CoordinationCloud,
): Promise<CoordinationCommandResult> {
  const callerAccountId = await cloud.getCallerAccountId();
  const reasons = collectRequestIdentityReasons(request, callerAccountId);
  if (reasons.length > 0) {
    return reject(reasons);
  }

  const stackId = COORDINATION_STACK_ID;
  const stack = await cloud.describeStack(stackId);
  const table = await cloud.describeTable(COORDINATION_TABLE_NAME);
  reasons.push(
    ...collectDeployedIdentityReasons(
      callerAccountId,
      ALLOWED_REGION,
      stack,
      table,
    ),
  );
  return reasons.length > 0 ? reject(reasons) : { status: "verified" };
}

export function collectRequestIdentityReasons(
  request: CoordinationCommandRequest,
  callerAccountId: string,
): CoordinationRejection[] {
  const reasons: CoordinationRejection[] = [];
  const allowlisted = request.allowlistedAccountId;

  if (!isTwelveDigitAccountId(allowlisted)) {
    reasons.push({
      code: "account_not_12_digit",
      category: "account",
      expected: "12-digit account id",
      observed: allowlisted,
    });
  }
  if (!isTwelveDigitAccountId(callerAccountId)) {
    reasons.push({
      code: "account_not_12_digit",
      category: "account",
      expected: "12-digit account id",
      observed: callerAccountId,
    });
  }
  if (
    isTwelveDigitAccountId(allowlisted) &&
    isTwelveDigitAccountId(callerAccountId) &&
    allowlisted !== callerAccountId
  ) {
    reasons.push({
      code: "account_not_allowlisted",
      category: "account",
      expected: allowlisted,
      observed: callerAccountId,
    });
  }

  if (request.region !== ALLOWED_REGION) {
    reasons.push({
      code: "region_not_allowed",
      category: "region",
      expected: ALLOWED_REGION,
      observed: request.region,
    });
  }

  if (request.stackId !== COORDINATION_STACK_ID) {
    reasons.push({
      code: "coordination_stack_identity_mismatch",
      category: "coordination",
      expected: COORDINATION_STACK_ID,
      observed: request.stackId,
    });
  }

  return reasons;
}

export function collectDeployedIdentityReasons(
  accountId: string,
  region: string,
  stack: StackObservation | undefined,
  table: TableObservation | undefined,
): CoordinationRejection[] {
  const reasons: CoordinationRejection[] = [];

  if (stack === undefined) {
    reasons.push({
      code: "coordination_stack_missing",
      category: "coordination",
      expected: COORDINATION_STACK_ID,
      observed: undefined,
    });
  } else if (stack.stackId !== COORDINATION_STACK_ID) {
    reasons.push({
      code: "coordination_stack_identity_mismatch",
      category: "coordination",
      expected: COORDINATION_STACK_ID,
      observed: stack.stackId,
    });
  } else if (!isReadyCoordinationStackStatus(stack.status)) {
    reasons.push({
      code: "coordination_stack_status_unverified",
      category: "coordination",
      expected: [...READY_COORDINATION_STACK_STATUSES],
      observed: stack.status,
    });
  }

  if (table === undefined) {
    reasons.push({
      code: "coordination_table_missing",
      category: "coordination",
      expected: COORDINATION_TABLE_NAME,
      observed: undefined,
    });
    return reasons;
  }

  if (table.tableName !== COORDINATION_TABLE_NAME) {
    reasons.push({
      code: "coordination_table_name_mismatch",
      category: "coordination",
      expected: COORDINATION_TABLE_NAME,
      observed: table.tableName,
    });
  }

  if (!isFrozenCoordinationTableArn(table.tableArn, accountId, region)) {
    reasons.push({
      code: "coordination_resource_identity_mismatch",
      category: "coordination",
      expected: buildCoordinationTableArn(accountId, region),
      observed: table.tableArn,
    });
  }

  if (!hasFrozenKeySchema(table)) {
    reasons.push({
      code: "coordination_key_schema_mismatch",
      category: "coordination",
      expected: [{ attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" }],
      observed: table.keySchema,
    });
  }

  if (!isExpectedCoordinationSchemaVersion(table.schemaVersion)) {
    reasons.push({
      code: "coordination_schema_version_mismatch",
      category: "coordination",
      expected: EXPECTED_COORDINATION_SCHEMA_VERSION,
      observed: table.schemaVersion,
    });
  }

  if (table.ttlEnabled) {
    reasons.push({
      code: "coordination_ttl_enabled",
      category: "coordination",
      expected: false,
      observed: true,
    });
  }

  return reasons;
}

export function reject(reasons: CoordinationRejection[]): CoordinationCommandResult {
  return { status: "rejected", reasons };
}

function hasFrozenKeySchema(table: TableObservation): boolean {
  return (
    table.keySchema.length === 1 &&
    table.keySchema[0]?.attributeName === COORDINATION_LEASE_KEY_ATTRIBUTE &&
    table.keySchema[0]?.keyType === "HASH"
  );
}
