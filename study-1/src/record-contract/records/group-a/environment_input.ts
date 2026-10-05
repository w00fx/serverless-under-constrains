// `environment_input` (BR-RUA-041): the operator-specific admission input. The schema closes
// the object, so it cannot carry credentials, tokens, passwords or credential-process commands.

/** Exactly one 12-digit AWS account id, kept as a string so leading zeros survive. */
export type AccountAllowlist = readonly [string];

export interface EnvironmentInput {
  readonly schema_version: 1;
  readonly record_type: 'environment_input';
  readonly account_allowlist: AccountAllowlist;
  readonly coordination_table_arn: string;
  /** CloudFormation stack ARN of the baseline coordination stack. */
  readonly coordination_stack_id: string;
  readonly expected_coordination_schema_version: number;
}
