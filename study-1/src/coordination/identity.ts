export const ALLOWED_REGION = "us-east-1";
export const EXPECTED_COORDINATION_SCHEMA_VERSION = 1;
export const COORDINATION_STACK_ID = "study-1-coordination";
export const COORDINATION_TABLE_NAME = "study-1-coordination";
export const COORDINATION_LEASE_KEY_ATTRIBUTE = "lease_key";
export const COORDINATION_DESTROY_CONFIRMATION = "DESTROY_BASELINE_COORDINATION";
export const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
export const STALE_BOUNDARY_MS = 300_000;
export const READY_COORDINATION_STACK_STATUSES = [
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
] as const;

export type ParsedCoordinationArn = {
  service: string;
  region: string;
  accountId: string;
  resource: string;
};

export function isTwelveDigitAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

export function isExpectedCoordinationSchemaVersion(value: unknown): boolean {
  return (
    value === EXPECTED_COORDINATION_SCHEMA_VERSION ||
    value === String(EXPECTED_COORDINATION_SCHEMA_VERSION)
  );
}

export function isReadyCoordinationStackStatus(value: unknown): boolean {
  return READY_COORDINATION_STACK_STATUSES.some((status) => status === value);
}

export function buildCoordinationTableArn(accountId: string, region: string): string {
  return `arn:aws:dynamodb:${region}:${accountId}:table/${COORDINATION_TABLE_NAME}`;
}

export function parseCoordinationArn(arn: string): ParsedCoordinationArn | undefined {
  const match = /^arn:aws:([^:]+):([^:]+):([^:]+):(table\/[^/\s]+)$/.exec(arn);
  if (match === null) {
    return undefined;
  }
  return {
    service: match[1] as string,
    region: match[2] as string,
    accountId: match[3] as string,
    resource: match[4] as string,
  };
}

export function isFrozenCoordinationTableArn(
  arn: string,
  accountId: string,
  region: string,
): boolean {
  const parsed = parseCoordinationArn(arn);
  return (
    parsed !== undefined &&
    parsed.service === "dynamodb" &&
    parsed.region === region &&
    parsed.accountId === accountId &&
    parsed.resource === `table/${COORDINATION_TABLE_NAME}`
  );
}
