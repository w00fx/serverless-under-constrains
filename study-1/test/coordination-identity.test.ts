import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_REGION,
  buildCoordinationTableArn,
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  isExpectedCoordinationSchemaVersion,
  isFrozenCoordinationTableArn,
  isReadyCoordinationStackStatus,
  isTwelveDigitAccountId,
  parseCoordinationArn,
} from "../src/coordination/identity.ts";

describe("coordination identity contract", () => {
  it("pins the frozen table, stack, and lease-key literals", () => {
    assert.equal(COORDINATION_TABLE_NAME, "study-1-coordination");
    assert.equal(COORDINATION_STACK_ID, "study-1-coordination");
    assert.equal(COORDINATION_LEASE_KEY_ATTRIBUTE, "lease_key");
    assert.equal(ALLOWED_REGION, "us-east-1");
  });

  it("accepts only a 12-digit account string", () => {
    assert.equal(isTwelveDigitAccountId("123456789012"), true);
    assert.equal(isTwelveDigitAccountId("000000000000"), true);
    assert.equal(isTwelveDigitAccountId(123456789012), false);
    assert.equal(isTwelveDigitAccountId("12345678901"), false);
    assert.equal(isTwelveDigitAccountId("1234567890123"), false);
    assert.equal(isTwelveDigitAccountId("12345678901a"), false);
    assert.equal(isTwelveDigitAccountId(" 123456789012"), false);
  });

  it("accepts schema version 1 as a number or exact decimal string", () => {
    assert.equal(isExpectedCoordinationSchemaVersion(1), true);
    assert.equal(isExpectedCoordinationSchemaVersion("1"), true);
    assert.equal(isExpectedCoordinationSchemaVersion("01"), false);
    assert.equal(isExpectedCoordinationSchemaVersion(1.0), true);
    assert.equal(isExpectedCoordinationSchemaVersion(2), false);
    assert.equal(isExpectedCoordinationSchemaVersion(true), false);
  });

  it("accepts only ready stack statuses", () => {
    assert.equal(isReadyCoordinationStackStatus("CREATE_COMPLETE"), true);
    assert.equal(isReadyCoordinationStackStatus("UPDATE_COMPLETE"), true);
    assert.equal(isReadyCoordinationStackStatus("CREATE_IN_PROGRESS"), false);
    assert.equal(isReadyCoordinationStackStatus("ROLLBACK_COMPLETE"), false);
    assert.equal(isReadyCoordinationStackStatus(undefined), false);
  });

  it("parses a DynamoDB table ARN and rejects malformed values", () => {
    const arn = buildCoordinationTableArn("123456789012", ALLOWED_REGION);
    assert.deepEqual(parseCoordinationArn(arn), {
      service: "dynamodb",
      region: ALLOWED_REGION,
      accountId: "123456789012",
      resource: `table/${COORDINATION_TABLE_NAME}`,
    });
    assert.deepEqual(
      parseCoordinationArn(
        `arn:aws:dynamodb:${ALLOWED_REGION}:123456789012:table/${COORDINATION_TABLE_NAME}:extra`,
      ),
      {
        service: "dynamodb",
        region: ALLOWED_REGION,
        accountId: "123456789012",
        resource: `table/${COORDINATION_TABLE_NAME}:extra`,
      },
    );
    assert.equal(parseCoordinationArn("arn:aws:dynamodb"), undefined);
    assert.equal(parseCoordinationArn("arn:aws::us-east-1:123456789012:table/x"), undefined);
    assert.equal(parseCoordinationArn("arn:aws:dynamodb::123456789012:table/x"), undefined);
    assert.equal(parseCoordinationArn("arn:aws:dynamodb:::table/x"), undefined);
    assert.equal(parseCoordinationArn("arn:aws:dynamodb:us-east-1::table/x"), undefined);
    assert.equal(parseCoordinationArn("arn:aws:dynamodb:us-east-1:123456789012:"), undefined);
    assert.equal(parseCoordinationArn("foo:aws:dynamodb:us-east-1:123456789012:table/x"), undefined);
    assert.equal(parseCoordinationArn("arn:gcp:dynamodb:us-east-1:123456789012:table/x"), undefined);
    assert.equal(parseCoordinationArn(`x${arn}`), undefined);
    assert.equal(parseCoordinationArn(`${arn}\ntrailing`), undefined);
    assert.equal(
      parseCoordinationArn(
        "nope-arn:aws:dynamodb:us-east-1:123456789012:table/study-1-coordination",
      ),
      undefined,
    );
    assert.equal(parseCoordinationArn(`${arn} `), undefined);
    assert.equal(parseCoordinationArn(`${arn}/extra`), undefined);
    assert.equal(
      parseCoordinationArn(`arn:aws:dynamodb:${ALLOWED_REGION}:123456789012:bucket/x`),
      undefined,
    );
    assert.equal(
      parseCoordinationArn(`arn:aws:dynamodb:${ALLOWED_REGION}:123456789012:table/`),
      undefined,
    );
  });

  it("accepts only the frozen table ARN for the caller account and Region", () => {
    const account = "123456789012";
    const matching = buildCoordinationTableArn(account, ALLOWED_REGION);
    assert.equal(isFrozenCoordinationTableArn(matching, account, ALLOWED_REGION), true);
    assert.equal(
      isFrozenCoordinationTableArn(
        buildCoordinationTableArn("999999999999", ALLOWED_REGION),
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(
      isFrozenCoordinationTableArn(
        `arn:aws:dynamodb:us-west-2:${account}:table/${COORDINATION_TABLE_NAME}`,
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(
      isFrozenCoordinationTableArn(
        `arn:aws:s3:${ALLOWED_REGION}:${account}:table/${COORDINATION_TABLE_NAME}`,
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(
      isFrozenCoordinationTableArn(`${matching}/index/gsi`, account, ALLOWED_REGION),
      false,
    );
    assert.equal(
      isFrozenCoordinationTableArn(
        `arn:aws:dynamodb:${ALLOWED_REGION}:${account}:table/other-table`,
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(
      isFrozenCoordinationTableArn(
        `arn:aws:dynamodb:${ALLOWED_REGION}:${account}:table/${COORDINATION_TABLE_NAME}:extra`,
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(isFrozenCoordinationTableArn("arn:aws:dynamodb", account, ALLOWED_REGION), false);
    assert.equal(isFrozenCoordinationTableArn("not-an-arn", account, ALLOWED_REGION), false);
    assert.equal(
      isFrozenCoordinationTableArn(
        "nope-arn:aws:dynamodb:us-east-1:123456789012:table/study-1-coordination",
        account,
        ALLOWED_REGION,
      ),
      false,
    );
    assert.equal(isFrozenCoordinationTableArn(`${matching} `, account, ALLOWED_REGION), false);
    assert.equal(isFrozenCoordinationTableArn(`${matching}/extra`, account, ALLOWED_REGION), false);
  });
});
