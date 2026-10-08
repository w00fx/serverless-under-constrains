// Group-C examples of the operator surface: the oracle revision check and the CLI result line
// (catalogue rows 87 and 88).

import type { CliResult } from '../../../../../src/record-contract/records/group-c/cli_result.ts';
import type { OracleRevisionCheck } from '../../../../../src/record-contract/records/group-c/oracle_revision_check.ts';
import { RUN_ID, at, digest, reason, uuid } from '../../../../support/record-contract/record-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const TREE_SHA = '89abcdef0123456789abcdef0123456789abcdef';

/**
 * The golden suite passed at a clean commit and covers every verdict-changing pair (BR-RUA-055).
 *
 * @example
 * passedRevisionCheck().result; // 'passed'
 */
export function passedRevisionCheck(): OracleRevisionCheck {
  return {
    schema_version: 1,
    record_type: 'oracle_revision_check',
    admission_attempt_id: uuid(0x900),
    commit_sha: COMMIT_SHA,
    tree_sha: TREE_SHA,
    command: 'npm run test:golden',
    exit_code: 0,
    report_sha256: digest('golden-report'),
    test_counts: { tests: 120, pass: 120, fail: 0, skipped: 0, todo: 0 },
    golden_minimum: 100,
    rule_coverage: [
      { rule_id: 'BR-RUA-001', outcome: 'fail', case_ids: ['golden-001', 'golden-002'] },
      { rule_id: 'BR-RUA-001', outcome: 'pass', case_ids: ['golden-003'] },
      { rule_id: 'INV-RUA-001', outcome: 'indeterminate', case_ids: ['golden-004'] },
      { rule_id: 'settlement', outcome: 'not_applicable', case_ids: ['golden-005'] },
    ],
    uncovered: [],
    node_version: 'v24.15.0',
    result: 'passed',
    reasons: [],
    checked_at: at(10000),
  };
}

/**
 * A skipped golden test and an uncovered pair fail the check.
 *
 * @example
 * failedRevisionCheck().result; // 'failed'
 */
export function failedRevisionCheck(): OracleRevisionCheck {
  return {
    ...passedRevisionCheck(),
    exit_code: 1,
    test_counts: { tests: 120, pass: 118, fail: 1, skipped: 1, todo: 0 },
    uncovered: ['BR-RUA-025:fail'],
    result: 'failed',
    reasons: [reason('GOLDEN_SUITE_FAILED', 'golden suite'), reason('RULE_PAIR_UNCOVERED', 'BR-RUA-025:fail')],
  };
}

/**
 * `rua run` completed: exit 0, the package paths it wrote and its summary record (design §11).
 *
 * @example
 * completedCliResult().exit_code; // 0
 */
export function completedCliResult(): CliResult {
  return {
    schema_version: 1,
    record_type: 'cli_result',
    command: 'run start',
    outcome: 'completed',
    exit_code: 0,
    run_id: RUN_ID,
    written_paths: ['package-index.json', 'summary/run-summary.json'],
    result_record: { schema_version: 1, record_type: 'run_summary', comparison_eligibility: 'eligible' },
    reasons: [],
    completed_at: at(11000),
  };
}

/**
 * A usage error names no execution and wrote nothing.
 *
 * @example
 * usageErrorCliResult().outcome; // 'usage_error'
 */
export function usageErrorCliResult(): CliResult {
  return {
    schema_version: 1,
    record_type: 'cli_result',
    command: 'run',
    outcome: 'usage_error',
    exit_code: 2,
    written_paths: [],
    reasons: [reason('UNKNOWN_SUBCOMMAND', 'run')],
    completed_at: at(11010),
  };
}

export const OPERATOR_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('oracle_revision_check', passedRevisionCheck(), ['admission_attempt_id']),
  groupCExample('oracle_revision_check (failed)', failedRevisionCheck(), ['admission_attempt_id']),
  groupCExample('cli_result', completedCliResult(), ['run_id', 'result_record']),
  groupCExample('cli_result (usage error)', usageErrorCliResult()),
];
