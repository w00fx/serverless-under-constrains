import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_REGION,
  buildCoordinationTableArn,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  READY_COORDINATION_STACK_STATUSES,
} from "../src/coordination/identity.ts";
import type {
  CoordinationRejection,
  TableKeyAttribute,
} from "../src/coordination/types.ts";
import {
  collectDeployedIdentityReasons,
  collectRequestIdentityReasons,
  verifyCoordination,
} from "../src/coordination/verify.ts";
import {
  ACCOUNT,
  matchingCloud,
  matchingStack,
  matchingTable,
} from "./fake-coordination-cloud.ts";

function codes(reasons: CoordinationRejection[]): string[] {
  return reasons.map((reason) => reason.code);
}

describe("coordination rejection diagnostics", () => {
  it("records account, Region, and requested-stack failures without extra mismatch codes", () => {
    const malformedAllowlist = collectRequestIdentityReasons(
      { allowlistedAccountId: "123", region: ALLOWED_REGION, stackId: COORDINATION_STACK_ID },
      ACCOUNT,
    );
    assert.deepEqual(malformedAllowlist, [
      {
        code: "account_not_12_digit",
        category: "account",
        expected: "12-digit account id",
        observed: "123",
      },
    ]);

    const malformedCaller = collectRequestIdentityReasons(
      { allowlistedAccountId: ACCOUNT, region: ALLOWED_REGION, stackId: COORDINATION_STACK_ID },
      "abc",
    );
    assert.deepEqual(malformedCaller, [
      {
        code: "account_not_12_digit",
        category: "account",
        expected: "12-digit account id",
        observed: "abc",
      },
    ]);

    const mismatched = collectRequestIdentityReasons(
      {
        allowlistedAccountId: ACCOUNT,
        region: ALLOWED_REGION,
        stackId: COORDINATION_STACK_ID,
      },
      "999999999999",
    );
    assert.deepEqual(mismatched, [
      {
        code: "account_not_allowlisted",
        category: "account",
        expected: ACCOUNT,
        observed: "999999999999",
      },
    ]);

    const wrongRegion = collectRequestIdentityReasons(
      { allowlistedAccountId: ACCOUNT, region: "us-west-2", stackId: COORDINATION_STACK_ID },
      ACCOUNT,
    );
    assert.deepEqual(wrongRegion, [
      {
        code: "region_not_allowed",
        category: "region",
        expected: ALLOWED_REGION,
        observed: "us-west-2",
      },
    ]);

    const wrongStack = collectRequestIdentityReasons(
      { allowlistedAccountId: ACCOUNT, region: ALLOWED_REGION, stackId: "other-stack" },
      ACCOUNT,
    );
    assert.deepEqual(wrongStack, [
      {
        code: "coordination_stack_identity_mismatch",
        category: "coordination",
        expected: COORDINATION_STACK_ID,
        observed: "other-stack",
      },
    ]);
    assert.equal(codes(malformedAllowlist).includes("account_not_allowlisted"), false);
    assert.equal(codes(malformedCaller).includes("account_not_allowlisted"), false);
  });

  it("records each deployed-baseline failure with its category and expected value", () => {
    assert.deepEqual(collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, undefined, matchingTable()), [
      {
        code: "coordination_stack_missing",
        category: "coordination",
        expected: COORDINATION_STACK_ID,
        observed: undefined,
      },
    ]);

    assert.deepEqual(
      collectDeployedIdentityReasons(
        ACCOUNT,
        ALLOWED_REGION,
        { stackId: "other-stack", status: "CREATE_COMPLETE" },
        matchingTable(),
      ),
      [
        {
          code: "coordination_stack_identity_mismatch",
          category: "coordination",
          expected: COORDINATION_STACK_ID,
          observed: "other-stack",
        },
      ],
    );

    assert.deepEqual(
      collectDeployedIdentityReasons(
        ACCOUNT,
        ALLOWED_REGION,
        { stackId: COORDINATION_STACK_ID, status: "CREATE_IN_PROGRESS" },
        matchingTable(),
      ),
      [
        {
          code: "coordination_stack_status_unverified",
          category: "coordination",
          expected: [...READY_COORDINATION_STACK_STATUSES],
          observed: "CREATE_IN_PROGRESS",
        },
      ],
    );

    assert.deepEqual(
      collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), undefined),
      [
        {
          code: "coordination_table_missing",
          category: "coordination",
          expected: COORDINATION_TABLE_NAME,
          observed: undefined,
        },
      ],
    );

    const wrongName = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      tableName: "other-table",
    });
    assert.deepEqual(wrongName, [
      {
        code: "coordination_table_name_mismatch",
        category: "coordination",
        expected: COORDINATION_TABLE_NAME,
        observed: "other-table",
      },
    ]);

    const wrongArn = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      tableArn: buildCoordinationTableArn("999999999999", ALLOWED_REGION),
    });
    assert.deepEqual(wrongArn, [
      {
        code: "coordination_resource_identity_mismatch",
        category: "coordination",
        expected: buildCoordinationTableArn(ACCOUNT, ALLOWED_REGION),
        observed: buildCoordinationTableArn("999999999999", ALLOWED_REGION),
      },
    ]);

    const wrongKey = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      keySchema: [{ attributeName: "id", keyType: "HASH" }],
    });
    assert.deepEqual(wrongKey, [
      {
        code: "coordination_key_schema_mismatch",
        category: "coordination",
        expected: [{ attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" }],
        observed: [{ attributeName: "id", keyType: "HASH" }],
      },
    ]);

    const wrongSchema = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      schemaVersion: 2,
    });
    assert.deepEqual(wrongSchema, [
      {
        code: "coordination_schema_version_mismatch",
        category: "coordination",
        expected: EXPECTED_COORDINATION_SCHEMA_VERSION,
        observed: 2,
      },
    ]);

    const ttlOn = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      ttlEnabled: true,
    });
    assert.deepEqual(ttlOn, [
      {
        code: "coordination_ttl_enabled",
        category: "coordination",
        expected: false,
        observed: true,
      },
    ]);
  });

  it("fails closed when the hash key slot is present but empty", () => {
    const reasons = collectDeployedIdentityReasons(ACCOUNT, ALLOWED_REGION, matchingStack(), {
      ...matchingTable(),
      keySchema: [undefined as unknown as TableKeyAttribute],
    });
    assert.deepEqual(codes(reasons), ["coordination_key_schema_mismatch"]);
    assert.deepEqual(reasons[0]?.expected, [
      { attributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, keyType: "HASH" },
    ]);
  });

  it("does not read the deployed baseline when request identity already fails", async () => {
    const cases = [
      { allowlistedAccountId: "123", region: ALLOWED_REGION, stackId: COORDINATION_STACK_ID },
      { allowlistedAccountId: ACCOUNT, region: "us-west-2", stackId: COORDINATION_STACK_ID },
      { allowlistedAccountId: ACCOUNT, region: ALLOWED_REGION, stackId: "other-stack" },
    ];
    for (const request of cases) {
      const cloud = matchingCloud();
      const result = await verifyCoordination(request, cloud);
      assert.equal(result.status, "rejected");
      assert.deepEqual(cloud.describedStacks, []);
      assert.deepEqual(cloud.describedTables, []);
    }
  });
});
