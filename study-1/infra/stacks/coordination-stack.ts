// The baseline coordination stack `suc-study-1-coordination` (design §9.1, D-08; ADR
// manage-coordination-as-baseline-infrastructure; BR-RUA-045, BR-RUA-050). It is provisioned
// separately by the operator, once per account, and is never run-owned:
// - one table with string `pk`/`sk`, on demand;
// - no TTL attribute and no stream: TTL deletion is asynchronous and never proves release
//   ([R-aws] TTL), and nothing consumes lease changes;
// - `RemovalPolicy.RETAIN` and deletion protection, so neither a stack update nor a cleanup run
//   can drop the lease;
// - the baseline tags only (`suc:project`, `suc:study_id`, `suc:managed_by`): no `suc:run_id`,
//   so cleanup excludes it (BR-RUA-050) and billing never attributes it (BR-RUA-047).
// It holds no Lambda function, so no log group either (A-13 concerns function stacks).
// The outputs give admission what it compares with the environment input: the table ARN and
// name, and the coordination schema version of the item layout (`src/coordination-lease`).

import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

import { applyOwnershipTags, baselineTags } from '../ownership/ownership-tags.ts';

/** The stack name, which is also the table name (BR-RUA-050 baseline exclusion matches both). */
export const COORDINATION_STACK_NAME = 'suc-study-1-coordination';
export const COORDINATION_TABLE_NAME = 'suc-study-1-coordination';
/** The Region of every study resource (BR-RUA-046). */
export const COORDINATION_REGION = 'us-east-1';
/**
 * The layout version of the coordination items. `src/coordination-lease/lease-item.ts`
 * declares the same value; the synthesis test asserts they agree (infra may not import it).
 */
export const DECLARED_COORDINATION_SCHEMA_VERSION = 1;

export const COORDINATION_OUTPUTS = {
  tableArn: 'CoordinationTableArn',
  tableName: 'CoordinationTableName',
  schemaVersion: 'CoordinationSchemaVersion',
} as const;

/**
 * The operator-managed coordination baseline.
 *
 * @example
 * new CoordinationStack(app, COORDINATION_STACK_NAME, { env: { account, region: COORDINATION_REGION } });
 */
export class CoordinationStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.table = new Table(this, 'CoordinationTable', {
      tableName: COORDINATION_TABLE_NAME,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });
    applyOwnershipTags(this, baselineTags());
    new CfnOutput(this, COORDINATION_OUTPUTS.tableArn, { value: this.table.tableArn });
    new CfnOutput(this, COORDINATION_OUTPUTS.tableName, { value: this.table.tableName });
    new CfnOutput(this, COORDINATION_OUTPUTS.schemaVersion, { value: String(DECLARED_COORDINATION_SCHEMA_VERSION) });
  }
}
