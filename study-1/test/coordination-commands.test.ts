import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCoordination } from "../src/coordination/bootstrap.ts";
import { dispatchCoordinationCommand } from "../src/coordination/cli.ts";
import { destroyCoordination } from "../src/coordination/destroy.ts";
import {
  buildCoordinationTableArn,
  COORDINATION_DESTROY_CONFIRMATION,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  STALE_BOUNDARY_MS,
} from "../src/coordination/identity.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  DeployRequest,
  LeaseItem,
  StackObservation,
  TableObservation,
} from "../src/coordination/types.ts";
import { verifyCoordination } from "../src/coordination/verify.ts";

const ACCOUNT = "123456789012";
const NOW = new Date("2026-08-26T13:45:00.000Z");

class FakeCoordinationCloud implements CoordinationCloud {
  callerAccountId = ACCOUNT;
  stack: StackObservation | undefined;
  table: TableObservation | undefined;
  leases: LeaseItem[] = [];
  listLeasesError: Error | undefined;
  readonly deploys: DeployRequest[] = [];
  readonly destroys: string[] = [];

  getCallerAccountId(): string {
    return this.callerAccountId;
  }

  describeStack(): StackObservation | undefined {
    return this.stack;
  }

  describeTable(): TableObservation | undefined {
    return this.table;
  }

  listLeases(): LeaseItem[] {
    if (this.listLeasesError) {
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

function validRequest(): CoordinationCommandRequest {
  return {
    allowlistedAccountId: ACCOUNT,
    region: "us-east-1",
    stackId: COORDINATION_STACK_ID,
  };
}

function matchingTable(): TableObservation {
  return {
    tableName: COORDINATION_TABLE_NAME,
    tableArn: buildCoordinationTableArn(ACCOUNT, "us-east-1"),
    keySchema: [{ attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" }],
    schemaVersion: EXPECTED_COORDINATION_SCHEMA_VERSION,
    ttlEnabled: false,
  };
}

function matchingStack(): StackObservation {
  return { stackId: COORDINATION_STACK_ID, status: "CREATE_COMPLETE" };
}

function matchingCloud(): FakeCoordinationCloud {
  const cloud = new FakeCoordinationCloud();
  cloud.stack = matchingStack();
  cloud.table = matchingTable();
  return cloud;
}

function releasedLease(): LeaseItem {
  return {
    lease_key: `study-1/${ACCOUNT}/us-east-1`,
    schema_version: EXPECTED_COORDINATION_SCHEMA_VERSION,
    lease_status: "released",
    heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString(),
  };
}

test("AC-14: verify accepts the frozen matching baseline and does not mutate", async () => {
  const cloud = matchingCloud();
  const result = await verifyCoordination(validRequest(), cloud);
  assert.equal(result.status, "verified");
  assert.deepEqual(cloud.deploys, []);
  assert.deepEqual(cloud.destroys, []);
});

test("AC-14: verify rejects wrong account, Region, stack, table identity, schema, and TTL", async () => {
  const cases: Array<{
    name: string;
    setup: (cloud: FakeCoordinationCloud, request: CoordinationCommandRequest) => void;
    code: string;
  }> = [
    {
      name: "wrong caller account",
      setup: (cloud) => {
        cloud.callerAccountId = "999999999999";
      },
      code: "account_not_allowlisted",
    },
    {
      name: "non-12-digit account",
      setup: (_cloud, request) => {
        request.allowlistedAccountId = "123";
      },
      code: "account_not_12_digit",
    },
    {
      name: "wrong region",
      setup: (_cloud, request) => {
        request.region = "us-west-2";
      },
      code: "region_not_allowed",
    },
    {
      name: "wrong requested stack",
      setup: (_cloud, request) => {
        request.stackId = "other-stack";
      },
      code: "coordination_stack_identity_mismatch",
    },
    {
      name: "missing stack",
      setup: (cloud) => {
        cloud.stack = undefined;
      },
      code: "coordination_stack_missing",
    },
    {
      name: "missing table",
      setup: (cloud) => {
        cloud.table = undefined;
      },
      code: "coordination_table_missing",
    },
    {
      name: "wrong table name",
      setup: (cloud) => {
        cloud.table = { ...matchingTable(), tableName: "other-table" };
      },
      code: "coordination_table_name_mismatch",
    },
    {
      name: "wrong table ARN account",
      setup: (cloud) => {
        cloud.table = {
          ...matchingTable(),
          tableArn: buildCoordinationTableArn("999999999999", "us-east-1"),
        };
      },
      code: "coordination_resource_identity_mismatch",
    },
    {
      name: "wrong key schema",
      setup: (cloud) => {
        cloud.table = {
          ...matchingTable(),
          keySchema: [
            { attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" },
            { attributeName: "sk", keyType: "RANGE" },
          ],
        };
      },
      code: "coordination_key_schema_mismatch",
    },
    {
      name: "wrong schema version",
      setup: (cloud) => {
        cloud.table = { ...matchingTable(), schemaVersion: 2 };
      },
      code: "coordination_schema_version_mismatch",
    },
    {
      name: "ttl enabled",
      setup: (cloud) => {
        cloud.table = { ...matchingTable(), ttlEnabled: true };
      },
      code: "coordination_ttl_enabled",
    },
    {
      name: "transitional stack status",
      setup: (cloud) => {
        cloud.stack = { stackId: COORDINATION_STACK_ID, status: "CREATE_IN_PROGRESS" };
      },
      code: "coordination_stack_status_unverified",
    },
    {
      name: "failed stack status",
      setup: (cloud) => {
        cloud.stack = { stackId: COORDINATION_STACK_ID, status: "ROLLBACK_COMPLETE" };
      },
      code: "coordination_stack_status_unverified",
    },
    {
      name: "malformed schema version string",
      setup: (cloud) => {
        cloud.table = { ...matchingTable(), schemaVersion: "01" };
      },
      code: "coordination_schema_version_mismatch",
    },
  ];

  for (const testCase of cases) {
    const cloud = matchingCloud();
    const request = validRequest();
    testCase.setup(cloud, request);
    const result = await verifyCoordination(request, cloud);
    assert.equal(result.status, "rejected", testCase.name);
    if (result.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
      testCase.name,
    );
    assert.deepEqual(cloud.deploys, []);
    assert.deepEqual(cloud.destroys, []);
  }
});

test("AC-14: verify accepts string schema version 1 and UPDATE_COMPLETE stack status", async () => {
  const cloud = matchingCloud();
  cloud.stack = { stackId: COORDINATION_STACK_ID, status: "UPDATE_COMPLETE" };
  cloud.table = { ...matchingTable(), schemaVersion: "1" };
  const result = await verifyCoordination(validRequest(), cloud);
  assert.equal(result.status, "verified");
});

test("AC-14: bootstrap rejects a transitional existing stack instead of treating it as present", async () => {
  const cloud = matchingCloud();
  cloud.stack = { stackId: COORDINATION_STACK_ID, status: "UPDATE_IN_PROGRESS" };
  const result = await bootstrapCoordination(validRequest(), cloud);
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejection");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "coordination_stack_status_unverified"),
    true,
  );
  assert.deepEqual(cloud.deploys, []);
});

test("AC-14: bootstrap rejects wrong account, Region, or stack before any deploy", async () => {
  const cases: Array<{
    mutate: (request: CoordinationCommandRequest) => void;
    code: string;
  }> = [
    {
      mutate: (request) => {
        request.allowlistedAccountId = "999999999999";
      },
      code: "account_not_allowlisted",
    },
    {
      mutate: (request) => {
        request.region = "us-west-2";
      },
      code: "region_not_allowed",
    },
    {
      mutate: (request) => {
        request.stackId = "other-stack";
      },
      code: "coordination_stack_identity_mismatch",
    },
  ];

  for (const testCase of cases) {
    const cloud = new FakeCoordinationCloud();
    const request = validRequest();
    testCase.mutate(request);
    const result = await bootstrapCoordination(request, cloud);
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
    );
    assert.deepEqual(cloud.deploys, []);
  }
});

test("AC-23: bootstrap deploys only when the baseline is absent", async () => {
  const cloud = new FakeCoordinationCloud();
  const result = await bootstrapCoordination(validRequest(), cloud);
  assert.equal(result.status, "bootstrapped");
  assert.equal(cloud.deploys.length, 1);
  assert.equal(cloud.deploys[0]?.stackId, COORDINATION_STACK_ID);
  const resources = (
    cloud.deploys[0]?.template.Resources as Record<string, { Type?: string; Properties?: { TableName?: string } }>
  );
  const tables = Object.values(resources ?? {}).filter(
    (resource) => resource.Type === "AWS::DynamoDB::Table",
  );
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.Properties?.TableName, COORDINATION_TABLE_NAME);
  assert.deepEqual(cloud.destroys, []);
});

test("AC-23: bootstrap is a no-op for a compatible existing baseline", async () => {
  const cloud = matchingCloud();
  const result = await bootstrapCoordination(validRequest(), cloud);
  assert.equal(result.status, "already_present");
  assert.deepEqual(cloud.deploys, []);
  assert.deepEqual(cloud.destroys, []);
});

test("AC-14: bootstrap rejects incompatible existing state and does not migrate", async () => {
  const cloud = matchingCloud();
  cloud.table = { ...matchingTable(), schemaVersion: 2 };
  const result = await bootstrapCoordination(validRequest(), cloud);
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejection");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "coordination_schema_version_mismatch"),
    true,
  );
  assert.deepEqual(cloud.deploys, []);
});

test("AC-14: bootstrap rejects a partial baseline without creating the missing half", async () => {
  const cloud = new FakeCoordinationCloud();
  cloud.stack = matchingStack();
  const result = await bootstrapCoordination(validRequest(), cloud);
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejection");
  }
  assert.equal(result.reasons[0]?.code, "coordination_baseline_incompatible");
  assert.deepEqual(cloud.deploys, []);
});

test("AC-23: destroy proceeds when the matching baseline has no leases", async () => {
  const cloud = matchingCloud();
  const result = await destroyCoordination(
    { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
    cloud,
    () => NOW,
  );
  assert.equal(result.status, "destroyed");
  assert.deepEqual(cloud.destroys, [COORDINATION_STACK_ID]);
});

test("AC-23: destroy proceeds for a released stale lease with numeric or string schema version", async () => {
  const variants: Array<Record<string, unknown>> = [
    { schema_version: 1 },
    { schema_version: "1" },
    {
      schema_version: 1,
      owner_id: "probe-1",
      owner_kind: "TRANSPORT_PROBE",
    },
  ];
  for (const extra of variants) {
    const cloud = matchingCloud();
    cloud.leases = [{ ...releasedLease(), ...extra }];
    const result = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      cloud,
      () => NOW,
    );
    assert.equal(result.status, "destroyed", JSON.stringify(extra));
    assert.deepEqual(cloud.destroys, [COORDINATION_STACK_ID]);
    assert.deepEqual(cloud.deploys, []);
  }
});

test("AC-23: destroy refuses every missing guard without mutation", async () => {
  const cases: Array<{
    name: string;
    setup: (cloud: FakeCoordinationCloud, request: CoordinationCommandRequest) => void;
    code: string;
  }> = [
    {
      name: "missing confirmation",
      setup: () => undefined,
      code: "destroy_confirmation_invalid",
    },
    {
      name: "wrong confirmation",
      setup: (_cloud, request) => {
        request.confirmation = COORDINATION_STACK_ID;
      },
      code: "destroy_confirmation_invalid",
    },
    {
      name: "wrong account",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.callerAccountId = "999999999999";
      },
      code: "account_not_allowlisted",
    },
    {
      name: "wrong region",
      setup: (_cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        request.region = "eu-west-1";
      },
      code: "region_not_allowed",
    },
    {
      name: "wrong stack id",
      setup: (_cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        request.stackId = "other-stack";
      },
      code: "coordination_stack_identity_mismatch",
    },
    {
      name: "wrong deployed table",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.table = { ...matchingTable(), tableName: "other-table" };
      },
      code: "coordination_table_name_mismatch",
    },
    {
      name: "active lease",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          {
            ...releasedLease(),
            lease_status: undefined,
            owner_kind: "TRANSPORT_PROBE",
            owner_id: "probe-1",
            heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString(),
          },
        ];
      },
      code: "coordination_lease_active",
    },
    {
      name: "non-stale lease",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          {
            ...releasedLease(),
            heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS + 1).toISOString(),
          },
        ];
      },
      code: "coordination_lease_non_stale",
    },
    {
      name: "recovery-required lease",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          {
            ...releasedLease(),
            lease_status: "recovery_required",
            heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString(),
          },
        ];
      },
      code: "coordination_lease_recovery_required",
    },
    {
      name: "unreadable leases",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.listLeasesError = new Error("dynamodb unavailable");
      },
      code: "coordination_state_unverified",
    },
    {
      name: "malformed lease",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [{ lease_key: "", schema_version: 1 }];
      },
      code: "coordination_state_unverified",
    },
    {
      name: "incomplete lease missing status and owner",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          {
            lease_key: `study-1/${ACCOUNT}/us-east-1`,
            schema_version: 1,
          },
        ];
      },
      code: "coordination_state_unverified",
    },
    {
      name: "lease with invalid status and no owner",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          {
            lease_key: `study-1/${ACCOUNT}/us-east-1`,
            schema_version: "1",
            lease_status: "",
          },
        ];
      },
      code: "coordination_state_unverified",
    },
    {
      name: "lease with malformed schema version",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [{ ...releasedLease(), schema_version: "01" }];
      },
      code: "coordination_state_unverified",
    },
    {
      name: "released lease with numeric owner_id",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [{ ...releasedLease(), owner_id: 42 }];
      },
      code: "coordination_state_unverified",
    },
    {
      name: "released lease with object owner_kind",
      setup: (cloud, request) => {
        request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
        cloud.leases = [
          { ...releasedLease(), owner_kind: { kind: "TRANSPORT_PROBE" } },
        ];
      },
      code: "coordination_state_unverified",
    },
  ];

  for (const testCase of cases) {
    const cloud = matchingCloud();
    const request = validRequest();
    testCase.setup(cloud, request);
    const result = await destroyCoordination(request, cloud, () => NOW);
    assert.equal(result.status, "rejected", testCase.name);
    if (result.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
      `${testCase.name} missing ${testCase.code}: ${result.reasons.map((reason) => reason.code).join(",")}`,
    );
    assert.deepEqual(cloud.destroys, [], testCase.name);
    assert.deepEqual(cloud.deploys, [], testCase.name);
  }
});

test("AC-23: command dispatch keeps bootstrap, verify, and destroy separate", async () => {
  const cloud = matchingCloud();
  const verified = await dispatchCoordinationCommand("verify", validRequest(), cloud);
  assert.equal(verified.status, "verified");
  assert.deepEqual(cloud.deploys, []);
  assert.deepEqual(cloud.destroys, []);

  const bootstrapped = await dispatchCoordinationCommand(
    "bootstrap",
    validRequest(),
    cloud,
  );
  assert.equal(bootstrapped.status, "already_present");
  assert.deepEqual(cloud.deploys, []);

  cloud.leases = [releasedLease()];
  const destroyed = await dispatchCoordinationCommand(
    "destroy",
    { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
    cloud,
    () => NOW,
  );
  assert.equal(destroyed.status, "destroyed");
  assert.deepEqual(cloud.destroys, [COORDINATION_STACK_ID]);
});
