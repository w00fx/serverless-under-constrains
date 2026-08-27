export type CoordinationRejectionCategory =
  | "account"
  | "region"
  | "coordination"
  | "configuration";

export type CoordinationRejection = {
  code: string;
  category: CoordinationRejectionCategory;
  expected?: unknown;
  observed?: unknown;
};

export type CoordinationCommandRequest = {
  allowlistedAccountId: unknown;
  region: unknown;
  stackId: unknown;
  confirmation?: unknown;
};

export type StackObservation = {
  stackId: string;
  status: string;
};

export type TableKeyAttribute = {
  attributeName: string;
  keyType: "HASH" | "RANGE";
};

export type TableObservation = {
  tableName: string;
  tableArn: string;
  keySchema: TableKeyAttribute[];
  schemaVersion: unknown;
  ttlEnabled: boolean;
};

export type LeaseItem = {
  lease_key?: unknown;
  schema_version?: unknown;
  owner_kind?: unknown;
  owner_id?: unknown;
  owner_manifest_digest?: unknown;
  heartbeat?: unknown;
  lease_status?: unknown;
};

export type DeployRequest = {
  stackId: string;
  template: Record<string, unknown>;
};

export interface CoordinationCloud {
  getCallerAccountId(): Promise<string> | string;
  describeStack(
    stackId: string,
  ): Promise<StackObservation | undefined> | StackObservation | undefined;
  describeTable(
    tableName: string,
  ): Promise<TableObservation | undefined> | TableObservation | undefined;
  listLeases(): Promise<LeaseItem[]> | LeaseItem[];
  deploy(request: DeployRequest): Promise<void> | void;
  destroyStack(stackId: string): Promise<void> | void;
}

export type CoordinationCommandStatus =
  | "verified"
  | "bootstrapped"
  | "already_present"
  | "destroyed"
  | "rejected";

export type CoordinationCommandResult =
  | { status: Exclude<CoordinationCommandStatus, "rejected"> }
  | { status: "rejected"; reasons: CoordinationRejection[] };
