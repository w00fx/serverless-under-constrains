import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bootstrapCoordination,
  synthesizeCoordinationTemplate,
} from "../src/coordination/bootstrap.ts";
import { dispatchCoordinationCommand } from "../src/coordination/cli.ts";
import { destroyCoordination } from "../src/coordination/destroy.ts";
import {
  ALLOWED_REGION,
  buildCoordinationTableArn,
  COORDINATION_DESTROY_CONFIRMATION,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  STALE_BOUNDARY_MS,
} from "../src/coordination/identity.ts";
import type {
  CoordinationCommandRequest,
  CoordinationCommandResult,
  LeaseItem,
} from "../src/coordination/types.ts";
import { verifyCoordination } from "../src/coordination/verify.ts";
import {
  ACCOUNT,
  FakeCoordinationCloud,
  matchingCloud,
  matchingStack,
  matchingTable,
  validRequest,
} from "./fake-coordination-cloud.ts";

const NOW = new Date("2026-08-30T21:00:00.000Z");

function releasedLease(): LeaseItem {
  return {
    lease_key: `study-1/${ACCOUNT}/us-east-1`,
    schema_version: EXPECTED_COORDINATION_SCHEMA_VERSION,
    lease_status: "released",
    heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString(),
  };
}

function assertRejected(
  result: CoordinationCommandResult,
  code: string,
  name: string,
): void {
  assert.equal(result.status, "rejected", name);
  if (result.status !== "rejected") {
    throw new Error("expected rejection");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === code),
    true,
    `${name} missing ${code}: ${result.reasons.map((reason) => reason.code).join(",")}`,
  );
}

describe("coordination verify", () => {
  it("accepts the frozen matching baseline and does not mutate", async () => {
    const cloud = matchingCloud();
    const result = await verifyCoordination(validRequest(), cloud);
    assert.equal(result.status, "verified");
    assert.deepEqual(cloud.deploys, []);
    assert.deepEqual(cloud.destroys, []);
    assert.deepEqual(cloud.describedStacks, [COORDINATION_STACK_ID]);
    assert.deepEqual(cloud.describedTables, [COORDINATION_TABLE_NAME]);
  });

  it("accepts string schema version 1 and UPDATE_COMPLETE", async () => {
    const cloud = matchingCloud();
    cloud.stack = { stackId: COORDINATION_STACK_ID, status: "UPDATE_COMPLETE" };
    cloud.table = { ...matchingTable(), schemaVersion: "1" };
    const result = await verifyCoordination(validRequest(), cloud);
    assert.equal(result.status, "verified");
  });

  it("rejects wrong account, Region, stack, table identity, schema, and TTL", async () => {
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
        name: "non-12-digit allowlist",
        setup: (_cloud, request) => {
          request.allowlistedAccountId = "123";
        },
        code: "account_not_12_digit",
      },
      {
        name: "non-12-digit caller",
        setup: (cloud) => {
          cloud.callerAccountId = "abc";
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
        name: "deployed stack identity mismatch",
        setup: (cloud) => {
          cloud.stack = { stackId: "other-stack", status: "CREATE_COMPLETE" };
        },
        code: "coordination_stack_identity_mismatch",
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
        name: "empty key schema",
        setup: (cloud) => {
          cloud.table = { ...matchingTable(), keySchema: [] };
        },
        code: "coordination_key_schema_mismatch",
      },
      {
        name: "hash attribute is not lease_key",
        setup: (cloud) => {
          cloud.table = {
            ...matchingTable(),
            keySchema: [{ attributeName: "id", keyType: "HASH" }],
          };
        },
        code: "coordination_key_schema_mismatch",
      },
      {
        name: "lease_key is RANGE not HASH",
        setup: (cloud) => {
          cloud.table = {
            ...matchingTable(),
            keySchema: [
              { attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "RANGE" },
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
      assertRejected(result, testCase.code, testCase.name);
      assert.deepEqual(cloud.deploys, []);
      assert.deepEqual(cloud.destroys, []);
    }
  });
});

describe("coordination bootstrap", () => {
  it("deploys only when the baseline is absent", async () => {
    const cloud = new FakeCoordinationCloud();
    const result = await bootstrapCoordination(validRequest(), cloud);
    assert.equal(result.status, "bootstrapped");
    assert.equal(cloud.deploys.length, 1);
    assert.equal(cloud.deploys[0]?.stackId, COORDINATION_STACK_ID);
    const resources = cloud.deploys[0]?.template.Resources as Record<
      string,
      { Type?: string; Properties?: { TableName?: string } }
    >;
    const tables = Object.values(resources ?? {}).filter(
      (resource) => resource.Type === "AWS::DynamoDB::Table",
    );
    assert.equal(tables.length, 1);
    assert.equal(tables[0]?.Properties?.TableName, COORDINATION_TABLE_NAME);
    assert.deepEqual(cloud.stack, matchingStack());
    assert.deepEqual(cloud.table, matchingTable());
    assert.deepEqual(cloud.destroys, []);
  });

  it("rejects when deploy does not leave a matching baseline", async () => {
    const missing = new FakeCoordinationCloud();
    missing.materializeOnDeploy = false;
    const missingResult = await bootstrapCoordination(validRequest(), missing);
    assertRejected(missingResult, "coordination_stack_missing", "missing after deploy");
    assertRejected(missingResult, "coordination_table_missing", "missing after deploy");
    assert.equal(missing.deploys.length, 1);

    const mismatched = new FakeCoordinationCloud();
    mismatched.deployedTable = { ...matchingTable(), schemaVersion: 2 };
    const mismatchedResult = await bootstrapCoordination(validRequest(), mismatched);
    assertRejected(mismatchedResult, "coordination_schema_version_mismatch", "schema after deploy");
    assert.equal(mismatched.deploys.length, 1);
  });

  it("rejects when the post-deploy baseline cannot be read", async () => {
    const errorCloud = new FakeCoordinationCloud();
    errorCloud.failDescribeStackAfter = 1;
    const errorResult = await bootstrapCoordination(validRequest(), errorCloud);
    assertRejected(errorResult, "coordination_state_unverified", "describe error");
    assert.equal(errorCloud.deploys.length, 1);

    const opaque = new FakeCoordinationCloud();
    opaque.failDescribeStackAfter = 1;
    opaque.describeStackError = "describe unavailable";
    const opaqueResult = await bootstrapCoordination(validRequest(), opaque);
    assertRejected(opaqueResult, "coordination_state_unverified", "opaque describe");
    if (opaqueResult.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.equal(opaqueResult.reasons[0]?.observed, "baseline describe failed");
    assert.equal(opaque.deploys.length, 1);
  });

  it("is a no-op for a compatible existing baseline", async () => {
    const cloud = matchingCloud();
    const result = await bootstrapCoordination(validRequest(), cloud);
    assert.equal(result.status, "already_present");
    assert.deepEqual(cloud.deploys, []);
    assert.deepEqual(cloud.destroys, []);
  });

  it("rejects a transitional existing stack instead of treating it as present", async () => {
    const cloud = matchingCloud();
    cloud.stack = { stackId: COORDINATION_STACK_ID, status: "UPDATE_IN_PROGRESS" };
    const result = await bootstrapCoordination(validRequest(), cloud);
    assertRejected(result, "coordination_stack_status_unverified", "transitional");
    assert.deepEqual(cloud.deploys, []);
  });

  it("rejects wrong account, Region, or stack before any deploy", async () => {
    const cases = [
      {
        mutate: (request: CoordinationCommandRequest) => {
          request.allowlistedAccountId = "999999999999";
        },
        code: "account_not_allowlisted",
      },
      {
        mutate: (request: CoordinationCommandRequest) => {
          request.region = "us-west-2";
        },
        code: "region_not_allowed",
      },
      {
        mutate: (request: CoordinationCommandRequest) => {
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
      assertRejected(result, testCase.code, testCase.code);
      assert.deepEqual(cloud.deploys, []);
    }
  });

  it("rejects incompatible existing state and does not migrate", async () => {
    const cloud = matchingCloud();
    cloud.table = { ...matchingTable(), schemaVersion: 2 };
    const result = await bootstrapCoordination(validRequest(), cloud);
    assertRejected(result, "coordination_schema_version_mismatch", "schema");
    assert.deepEqual(cloud.deploys, []);
  });

  it("rejects a partial baseline without creating the missing half", async () => {
    const stackOnly = new FakeCoordinationCloud();
    stackOnly.stack = matchingStack();
    const stackOnlyResult = await bootstrapCoordination(validRequest(), stackOnly);
    assertRejected(stackOnlyResult, "coordination_baseline_incompatible", "stack only");
    assert.deepEqual(stackOnly.deploys, []);
    if (stackOnlyResult.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.deepEqual(stackOnlyResult.reasons, [
      {
        code: "coordination_baseline_incompatible",
        category: "coordination",
        expected: "absent or complete matching stack and table",
        observed: { stack: COORDINATION_STACK_ID, table: undefined },
      },
    ]);

    const tableOnly = new FakeCoordinationCloud();
    tableOnly.table = matchingTable();
    const tableOnlyResult = await bootstrapCoordination(validRequest(), tableOnly);
    assertRejected(tableOnlyResult, "coordination_baseline_incompatible", "table only");
    assert.deepEqual(tableOnly.deploys, []);
    if (tableOnlyResult.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.deepEqual(tableOnlyResult.reasons, [
      {
        code: "coordination_baseline_incompatible",
        category: "coordination",
        expected: "absent or complete matching stack and table",
        observed: { stack: undefined, table: COORDINATION_TABLE_NAME },
      },
    ]);
  });

  it("synthesizes the template in an isolated directory and deletes it", () => {
    const prefix = COORDINATION_STACK_ID;
    const studyRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const cdkOut = join(studyRoot, "cdk.out");
    rmSync(cdkOut, { recursive: true, force: true });
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)),
    );
    const template = synthesizeCoordinationTemplate(ACCOUNT, ALLOWED_REGION);
    const resources = template.Resources as Record<string, { Type?: string }>;
    assert.ok(
      Object.values(resources ?? {}).some((resource) => resource.Type === "AWS::DynamoDB::Table"),
    );
    const leftovers = readdirSync(tmpdir()).filter(
      (name) => name.startsWith(prefix) && !before.has(name),
    );
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(cdkOut), false);
  });
});

describe("coordination destroy", () => {
  it("proceeds when the matching baseline has no leases", async () => {
    const cloud = matchingCloud();
    const result = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      cloud,
      () => NOW,
    );
    assert.equal(result.status, "destroyed");
    assert.deepEqual(cloud.destroys, [COORDINATION_STACK_ID]);
    assert.equal(cloud.stack, undefined);
    assert.equal(cloud.table, undefined);
  });

  it("rejects when destroy leaves stack or table", async () => {
    const leftoverStack = matchingCloud();
    leftoverStack.clearStackOnDestroy = false;
    leftoverStack.clearTableOnDestroy = true;
    const leftoverStackResult = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      leftoverStack,
      () => NOW,
    );
    assertRejected(leftoverStackResult, "coordination_state_unverified", "leftover stack");
    assert.deepEqual(leftoverStack.destroys, [COORDINATION_STACK_ID]);
    assert.deepEqual(leftoverStack.stack, matchingStack());

    const leftoverTable = matchingCloud();
    leftoverTable.clearStackOnDestroy = true;
    leftoverTable.clearTableOnDestroy = false;
    const leftoverTableResult = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      leftoverTable,
      () => NOW,
    );
    assertRejected(leftoverTableResult, "coordination_state_unverified", "leftover table");
    assert.deepEqual(leftoverTable.destroys, [COORDINATION_STACK_ID]);
    assert.deepEqual(leftoverTable.table, matchingTable());
  });

  it("rejects when the post-destroy baseline cannot be read", async () => {
    const errorCloud = matchingCloud();
    errorCloud.failDescribeStackAfter = 1;
    const errorResult = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      errorCloud,
      () => NOW,
    );
    assertRejected(errorResult, "coordination_state_unverified", "describe error");
    assert.deepEqual(errorCloud.destroys, [COORDINATION_STACK_ID]);

    const opaque = matchingCloud();
    opaque.failDescribeStackAfter = 1;
    opaque.describeStackError = "describe unavailable";
    const opaqueResult = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      opaque,
      () => NOW,
    );
    assertRejected(opaqueResult, "coordination_state_unverified", "opaque describe");
    if (opaqueResult.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.equal(opaqueResult.reasons[0]?.observed, "baseline describe failed");
    assert.deepEqual(opaque.destroys, [COORDINATION_STACK_ID]);
  });

  it("proceeds for a released stale lease with numeric or string schema version", async () => {
    const variants: Array<Record<string, unknown>> = [
      { schema_version: 1 },
      { schema_version: "1" },
      { schema_version: 1, owner_id: "probe-1", owner_kind: "TRANSPORT_PROBE" },
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

  it("refuses every missing guard without mutation", async () => {
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
        name: "stale-uncertain lease",
        setup: (cloud, request) => {
          request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
          cloud.leases = [
            {
              lease_key: `study-1/${ACCOUNT}/us-east-1`,
              schema_version: 1,
              heartbeat: new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString(),
            },
          ];
        },
        code: "coordination_state_unverified",
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
        name: "unreadable leases non-error",
        setup: (cloud, request) => {
          request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
          cloud.listLeasesError = "scan failed";
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
        name: "non-canonical heartbeat",
        setup: (cloud, request) => {
          request.confirmation = COORDINATION_DESTROY_CONFIRMATION;
          cloud.leases = [{ ...releasedLease(), heartbeat: "2020" }];
        },
        code: "coordination_state_unverified",
      },
    ];

    for (const testCase of cases) {
      const cloud = matchingCloud();
      const request = validRequest();
      testCase.setup(cloud, request);
      const result = await destroyCoordination(request, cloud, () => NOW);
      assertRejected(result, testCase.code, testCase.name);
      assert.deepEqual(cloud.destroys, [], testCase.name);
      assert.deepEqual(cloud.deploys, [], testCase.name);
    }
  });

  it("refuses destroy when any lease blocks even if another is released", async () => {
    const cloud = matchingCloud();
    cloud.leases = [
      releasedLease(),
      { ...releasedLease(), lease_status: "recovery_required" },
    ];
    const result = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      cloud,
      () => NOW,
    );
    assertRejected(result, "coordination_lease_recovery_required", "mixed");
    assert.deepEqual(cloud.destroys, []);
    assert.deepEqual(cloud.deploys, []);
  });

  it("uses the clock default when destroy is not given an explicit now", async () => {
    const cloud = matchingCloud();
    cloud.leases = [
      {
        ...releasedLease(),
        heartbeat: "2020-01-01T00:00:00.000Z",
      },
    ];
    const result = await destroyCoordination({
      ...validRequest(),
      confirmation: COORDINATION_DESTROY_CONFIRMATION,
    }, cloud);
    assert.equal(result.status, "destroyed");
    assert.deepEqual(cloud.destroys, [COORDINATION_STACK_ID]);
  });

  it("records destroy confirmation, scan, and lease-block diagnostics", async () => {
    const missingConfirmation = await destroyCoordination(validRequest(), matchingCloud(), () => NOW);
    assert.equal(missingConfirmation.status, "rejected");
    if (missingConfirmation.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.deepEqual(missingConfirmation.reasons, [
      {
        code: "destroy_confirmation_invalid",
        category: "configuration",
        expected: COORDINATION_DESTROY_CONFIRMATION,
        observed: undefined,
      },
    ]);

    const scanCloud = matchingCloud();
    scanCloud.listLeasesError = "scan failed";
    const unread = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      scanCloud,
      () => NOW,
    );
    assert.equal(unread.status, "rejected");
    if (unread.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.deepEqual(unread.reasons, [
      {
        code: "coordination_state_unverified",
        category: "coordination",
        expected: "readable lease items",
        observed: "lease scan failed",
      },
    ]);

    const blockedCloud = matchingCloud();
    const recoveryLease = { ...releasedLease(), lease_status: "recovery_required" };
    blockedCloud.leases = [recoveryLease];
    const blocked = await destroyCoordination(
      { ...validRequest(), confirmation: COORDINATION_DESTROY_CONFIRMATION },
      blockedCloud,
      () => NOW,
    );
    assert.equal(blocked.status, "rejected");
    if (blocked.status !== "rejected") {
      throw new Error("expected rejection");
    }
    assert.deepEqual(blocked.reasons, [
      {
        code: "coordination_lease_recovery_required",
        category: "coordination",
        expected: "no active, non-stale, or recovery-required leases",
        observed: recoveryLease,
      },
    ]);
  });
});

describe("coordination command dispatch", () => {
  it("keeps bootstrap, verify, and destroy separate", async () => {
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
});
