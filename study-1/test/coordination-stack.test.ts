import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createCoordinationApp } from "../src/coordination/cdk-app.ts";
import {
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
} from "../src/coordination/identity.ts";
import { CoordinationStack } from "../src/coordination/stack.ts";

function synthesizedTemplate(): Template {
  const app = new cdk.App();
  const stack = new CoordinationStack(app, COORDINATION_STACK_ID, {
    env: { account: "123456789012", region: "us-east-1" },
    stackName: COORDINATION_STACK_ID,
  });
  return Template.fromStack(stack);
}

describe("coordination stack synthesis", () => {
  it("synthesizes the frozen lease table identity and schema", () => {
    const template = synthesizedTemplate();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);

    const tables = template.findResources("AWS::DynamoDB::Table");
    const table = Object.values(tables)[0] as {
      Properties?: {
        TableName?: string;
        BillingMode?: string;
        AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: string }>;
        KeySchema?: Array<{ AttributeName: string; KeyType: string }>;
        SSESpecification?: { SSEEnabled?: boolean };
        TimeToLiveSpecification?: unknown;
        PointInTimeRecoverySpecification?: unknown;
        Tags?: Array<{ Key: string; Value: string }>;
      };
    };
    const properties = table.Properties;
    assert.equal(properties?.TableName, "study-1-coordination");
    assert.equal(properties?.TableName, COORDINATION_TABLE_NAME);
    assert.equal(properties?.BillingMode, "PAY_PER_REQUEST");
    assert.deepEqual(properties?.AttributeDefinitions, [
      { AttributeName: "lease_key", AttributeType: "S" },
    ]);
    assert.deepEqual(properties?.KeySchema, [
      { AttributeName: "lease_key", KeyType: "HASH" },
    ]);
    assert.equal(COORDINATION_LEASE_KEY_ATTRIBUTE, "lease_key");
    assert.notEqual(properties?.SSESpecification?.SSEEnabled, true);
    assert.equal(properties?.TimeToLiveSpecification, undefined);
    assert.equal(properties?.PointInTimeRecoverySpecification, undefined);

    const tags = Object.fromEntries(
      (properties?.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
    );
    assert.equal(tags.study, "study-1");
    assert.equal(tags.purpose, "baseline-coordination");
    assert.equal(
      tags["coordination-schema-version"],
      String(EXPECTED_COORDINATION_SCHEMA_VERSION),
    );
    assert.equal(tags["owned-by"], "lab-baseline");
    assert.equal(Object.hasOwn(tags, "run-id"), false);
    assert.equal(Object.hasOwn(tags, "variant"), false);
    assert.equal(Object.hasOwn(tags, "suc:run_id"), false);
  });

  it("requires the frozen Region and an explicit 12-digit account", () => {
    assert.throws(
      () => createCoordinationApp("123456789012", "us-west-2"),
      /requires region us-east-1/,
    );
    assert.throws(
      () => createCoordinationApp("123", "us-east-1"),
      /explicit 12-digit account/,
    );
    const app = createCoordinationApp("123456789012", "us-east-1");
    const stack = app.node.findChild(COORDINATION_STACK_ID);
    assert.ok(stack instanceof CoordinationStack);
    assert.equal(stack.stackName, COORDINATION_STACK_ID);
    assert.equal(stack.account, "123456789012");
    assert.equal(stack.region, "us-east-1");
    assert.equal(
      stack.templateOptions.description,
      "Study 1 baseline coordination lease table. Not run-owned. Operator-managed only.",
    );
  });

  it("reads account and Region from the CDK environment when omitted", () => {
    const previousAccount = process.env.CDK_DEFAULT_ACCOUNT;
    const previousRegion = process.env.CDK_DEFAULT_REGION;
    process.env.CDK_DEFAULT_ACCOUNT = "123456789012";
    delete process.env.CDK_DEFAULT_REGION;
    try {
      const app = createCoordinationApp();
      const stack = app.node.findChild(COORDINATION_STACK_ID);
      assert.ok(stack instanceof CoordinationStack);
      assert.equal(stack.account, "123456789012");
      assert.equal(stack.region, "us-east-1");
    } finally {
      if (previousAccount === undefined) {
        delete process.env.CDK_DEFAULT_ACCOUNT;
      } else {
        process.env.CDK_DEFAULT_ACCOUNT = previousAccount;
      }
      if (previousRegion === undefined) {
        delete process.env.CDK_DEFAULT_REGION;
      } else {
        process.env.CDK_DEFAULT_REGION = previousRegion;
      }
    }
  });

  it("rejects a missing account when environment defaults are absent", () => {
    const previousAccount = process.env.CDK_DEFAULT_ACCOUNT;
    delete process.env.CDK_DEFAULT_ACCOUNT;
    try {
      assert.throws(() => createCoordinationApp(), /explicit 12-digit account/);
    } finally {
      if (previousAccount === undefined) {
        delete process.env.CDK_DEFAULT_ACCOUNT;
      } else {
        process.env.CDK_DEFAULT_ACCOUNT = previousAccount;
      }
    }
  });
});
