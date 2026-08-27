import assert from "node:assert/strict";
import { test } from "node:test";
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

test("AC-23: CDK stack synthesizes the frozen lease table identity and schema", () => {
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
  assert.equal(properties?.TableName, COORDINATION_TABLE_NAME);
  assert.equal(properties?.BillingMode, "PAY_PER_REQUEST");
  assert.deepEqual(properties?.AttributeDefinitions, [
    { AttributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, AttributeType: "S" },
  ]);
  assert.deepEqual(properties?.KeySchema, [
    { AttributeName: COORDINATION_LEASE_KEY_ATTRIBUTE, KeyType: "HASH" },
  ]);
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
});

test("AC-23: CDK entry point requires the frozen Region and an explicit account", () => {
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
  assert.equal((stack as CoordinationStack).stackName, COORDINATION_STACK_ID);
});
