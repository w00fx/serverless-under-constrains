// Shared values of the admission tests (design §10.1, §12.2): one allowlisted account in the study
// Region, the environment input that names its coordination table and stack, a clean committed
// source, a supported toolchain, a correctly configured coordination table, and the OR-RUA-001
// financial records as an operator would hand them in.

import type { CoordinationTableDescription, ToolchainFacts } from '../../../src/admission/admission-ports.ts';
import type { FinancialInputRecords } from '../../../src/admission/admission-ports.ts';
import { OR_RUA_001_APPROVED_DECISION, OR_RUA_001_PAYMENT } from '../../../src/admission/declared-inputs.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';

export const ACCOUNT_ID = '012345678901';
export const FOREIGN_ACCOUNT_ID = '109876543210';
export const TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT_ID}:table/suc-study-1-coordination`;
export const STACK_ID = `arn:aws:cloudformation:us-east-1:${ACCOUNT_ID}:stack/SucStudy1Coordination/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`;
export const CALLER_ARN = `arn:aws:iam::${ACCOUNT_ID}:user/study-operator`;
export const ENVIRONMENT_INPUT_PATH = '/operator/environment-input.json';
export const EVIDENCE_ROOT = '/study/evidence';
export const STAGING_ROOT = '/staging';
export const COMMIT_SHA = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
export const TREE_SHA = '9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d';
export const BRANCH = 'feature/rua-study-1';
export const LOCKFILE_PATH = 'study-1/package-lock.json';
export const LOCKFILE_TEXT = '{"name":"study-1","lockfileVersion":3}\n';

/**
 * The environment input of the allowlisted account, with any member replaced.
 *
 * @example
 * environmentInput({ account_allowlist: ['109876543210'] });
 */
export function environmentInput(overrides: Readonly<Record<string, JsonObject[string]>> = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'environment_input',
    account_allowlist: [ACCOUNT_ID],
    coordination_table_arn: TABLE_ARN,
    coordination_stack_id: STACK_ID,
    expected_coordination_schema_version: 1,
    ...overrides,
  };
}

/**
 * The exact bytes an operator's environment input file holds.
 *
 * @example
 * environmentBytes(); // UTF-8 JSON of environmentInput()
 */
export function environmentBytes(input: JsonObject = environmentInput()): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

/** A toolchain that satisfies every A6 requirement. */
export const SUPPORTED_TOOLCHAIN: ToolchainFacts = {
  node_version: 'v24.15.0',
  npm_version: '11.6.2',
  esbuild_version: '0.25.10',
  aws_cdk_cli_version: '2.1144.0',
  dependency_tree_consistent: true,
  dependency_tree_detail: 'npm ls exited 0',
};

/** The coordination table as the baseline stack deploys it (design §9.1). */
export const CONFIGURED_TABLE: CoordinationTableDescription = {
  table_arn: TABLE_ARN,
  table_status: 'ACTIVE',
  key_schema: [
    { attribute_name: 'pk', key_type: 'HASH', attribute_type: 'S' },
    { attribute_name: 'sk', key_type: 'RANGE', attribute_type: 'S' },
  ],
  deletion_protection_enabled: true,
  time_to_live_status: 'DISABLED',
};

/**
 * The OR-RUA-001 records with members of either replaced.
 *
 * @example
 * financialRecords({ captured_amount_minor: 0 });
 */
export function financialRecords(
  payment: Readonly<Record<string, JsonObject[string]>> = {},
  decision: Readonly<Record<string, JsonObject[string]>> = {},
): FinancialInputRecords {
  return {
    payment: { ...OR_RUA_001_PAYMENT, ...payment },
    approved_decision: { ...OR_RUA_001_APPROVED_DECISION, ...decision },
  };
}
