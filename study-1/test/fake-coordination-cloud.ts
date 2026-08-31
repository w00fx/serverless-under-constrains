import {
  buildCoordinationTableArn,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
} from "../src/coordination/identity.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  DeployRequest,
  LeaseItem,
  StackObservation,
  TableObservation,
} from "../src/coordination/types.ts";

export const ACCOUNT = "123456789012";

export class FakeCoordinationCloud implements CoordinationCloud {
  callerAccountId = ACCOUNT;
  stack: StackObservation | undefined;
  table: TableObservation | undefined;
  leases: LeaseItem[] = [];
  listLeasesError: unknown;
  readonly describedStacks: string[] = [];
  readonly describedTables: string[] = [];
  readonly deploys: DeployRequest[] = [];
  readonly destroys: string[] = [];

  getCallerAccountId(): string {
    return this.callerAccountId;
  }

  describeStack(stackId: string): StackObservation | undefined {
    this.describedStacks.push(stackId);
    return this.stack;
  }

  describeTable(tableName: string): TableObservation | undefined {
    this.describedTables.push(tableName);
    return this.table;
  }

  listLeases(): LeaseItem[] {
    if (this.listLeasesError !== undefined) {
      throw this.listLeasesError;
    }
    return this.leases;
  }

  deploy(request: DeployRequest): void {
    this.deploys.push(request);
  }

  destroyStack(stackId: string): void {
    this.destroys.push(stackId);
  }
}

export function validRequest(): CoordinationCommandRequest {
  return {
    allowlistedAccountId: ACCOUNT,
    region: "us-east-1",
    stackId: COORDINATION_STACK_ID,
  };
}

export function matchingTable(): TableObservation {
  return {
    tableName: COORDINATION_TABLE_NAME,
    tableArn: buildCoordinationTableArn(ACCOUNT, "us-east-1"),
    keySchema: [{ attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" }],
    schemaVersion: EXPECTED_COORDINATION_SCHEMA_VERSION,
    ttlEnabled: false,
  };
}

export function matchingStack(): StackObservation {
  return { stackId: COORDINATION_STACK_ID, status: "CREATE_COMPLETE" };
}

export function matchingCloud(): FakeCoordinationCloud {
  const cloud = new FakeCoordinationCloud();
  cloud.stack = matchingStack();
  cloud.table = matchingTable();
  return cloud;
}
