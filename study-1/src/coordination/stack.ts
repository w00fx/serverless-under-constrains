import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import {
  COORDINATION_LEASE_KEY_ATTRIBUTE,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
} from "./identity.ts";

export class CoordinationStack extends cdk.Stack {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, "LeaseTable", {
      tableName: COORDINATION_TABLE_NAME,
      partitionKey: {
        name: COORDINATION_LEASE_KEY_ATTRIBUTE,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.DEFAULT,
    });

    cdk.Tags.of(this).add("study", "study-1");
    cdk.Tags.of(this).add("purpose", "baseline-coordination");
    cdk.Tags.of(this).add(
      "coordination-schema-version",
      String(EXPECTED_COORDINATION_SCHEMA_VERSION),
    );
    cdk.Tags.of(this).add("owned-by", "lab-baseline");

    new cdk.CfnOutput(this, "TableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "TableArn", { value: this.table.tableArn });
    new cdk.CfnOutput(this, "SchemaVersion", {
      value: String(EXPECTED_COORDINATION_SCHEMA_VERSION),
    });
    new cdk.CfnOutput(this, "StackIdentity", { value: COORDINATION_STACK_ID });
  }
}
