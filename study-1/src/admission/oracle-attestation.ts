// Admission step A9 (SAFETY, code ORACLE_NOT_FINAL; BR-RUA-055, design §10.1, D-18): the oracle is
// final at the admitted commit only when its golden suite, run there, attests it:
// - the command exited 0 and its report reads;
// - at least the summed golden minimum of tests ran, and none failed, was cancelled, skipped or todo;
// - every VERDICT_CHANGING_RULES id is reached by at least one passing trial-oracle golden case.
// A case passes when the report lists a passing test named by its `case_id` in a trial-oracle
// golden file (the goldens name each case's test by its id). Its declared `(rule, outcome)` pairs
// then count as covered. The `oracle_revision_check` record states all of it, passed or failed.

import { sha256Hex } from '../record-contract/digests.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason, UtcMillis, Uuid4 } from '../record-contract/primitives.ts';
import type { OracleRevisionCheck, RuleCoverage } from '../record-contract/records/group-c/oracle_revision_check.ts';
import { VERDICT_CHANGING_RULES } from '../trial-oracle/oracle-vocabulary.ts';
import type { GoldenCaseDeclaration, GoldenSuiteRun } from './admission-ports.ts';
import { admissionReason } from './admission-reason.ts';
import { parseSuiteReport } from './golden-report.ts';
import type { PassedSuiteTest, SuiteReport } from './golden-report.ts';
import { verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-055';
const CODE = 'ORACLE_NOT_FINAL';
/** Where the trial-oracle goldens live, relative to the study root. */
export const TRIAL_ORACLE_GOLDEN_DIRECTORY = 'test/golden/trial-oracle/';
const OUTCOME_PATTERN = /^[a-z][a-z_]*$/;
const MAX_EXIT_CODE = 255;

/** The commit, tree and runtime the golden suite ran at. */
export interface AttestationContext {
  readonly admission_attempt_id?: Uuid4;
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly node_version: string;
  readonly checked_at: UtcMillis;
}

/**
 * The `oracle_revision_check` record of one golden suite run.
 *
 * @example
 * oracleRevisionCheck(run, context).result; // 'passed' when the oracle is final at the commit
 */
export function oracleRevisionCheck(run: GoldenSuiteRun, context: AttestationContext): OracleRevisionCheck {
  const parsed = parseSuiteReport(run.report_bytes);
  const report = parsed.ok ? parsed.value : undefined;
  const coverage = ruleCoverage(run.case_declarations, report?.passed_tests ?? []);
  const covered = new Set(coverage.map((entry) => entry.rule_id));
  const uncovered = VERDICT_CHANGING_RULES.filter((ruleId) => !covered.has(ruleId));
  const reasons = [
    ...exitReasons(run),
    ...(parsed.ok
      ? countReasons(parsed.value)
      : [notFinal(`the golden report is unreadable: ${boundedText(parsed.error)}`)]),
    ...(uncovered.length === 0
      ? []
      : [
          notFinal(
            `no passing golden case covers ${uncovered.join(', ')}; expected every verdict-changing rule covered`,
          ),
        ]),
  ];
  const [first, ...rest] = reasons;
  return {
    schema_version: 1,
    record_type: 'oracle_revision_check',
    ...(context.admission_attempt_id === undefined ? {} : { admission_attempt_id: context.admission_attempt_id }),
    commit_sha: context.commit_sha,
    tree_sha: context.tree_sha,
    command: run.command,
    exit_code: recordableExitCode(run.exit_code),
    report_sha256: sha256Hex(run.report_bytes),
    test_counts: {
      tests: report?.counts.tests ?? 0,
      pass: report?.counts.passed ?? 0,
      fail: (report?.counts.failed ?? 0) + (report?.counts.cancelled ?? 0),
      skipped: report?.counts.skipped ?? 0,
      todo: report?.counts.todo ?? 0,
    },
    golden_minimum: report?.minimum ?? 0,
    rule_coverage: coverage,
    uncovered,
    node_version: context.node_version,
    ...(first === undefined ? { result: 'passed', reasons: [] } : { result: 'failed', reasons: [first, ...rest] }),
    checked_at: context.checked_at,
  };
}

/**
 * Step A9: the oracle revision check as a preflight verdict; it fails with ORACLE_NOT_FINAL.
 *
 * @example
 * const verdict = assessOracleAttestation(run, context);
 * if (!verdict.passed) verdict.reasons[0]?.code; // 'ORACLE_NOT_FINAL'
 */
export function assessOracleAttestation(
  run: GoldenSuiteRun,
  context: AttestationContext,
): StepVerdict<OracleRevisionCheck> {
  const record = oracleRevisionCheck(run, context);
  const statement: CheckStatement = {
    subject: 'oracle_revision_check',
    expected: { exit_code: 0, fail: 0, skipped: 0, todo: 0, uncovered: 0 },
    observed: {
      exit_code: record.exit_code,
      tests: record.test_counts.tests,
      fail: record.test_counts.fail,
      uncovered: record.uncovered.length,
      report_sha256: record.report_sha256,
    },
  };
  return verdictOf('SAFETY', statement, record.reasons, record);
}

/**
 * The verdict-changing pairs the passing cases reach, one entry per pair, in
 * VERDICT_CHANGING_RULES order and then outcome order, each with its sorted case ids.
 *
 * @example
 * ruleCoverage([{ case_id: 'consistent', rule_outcomes: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }] }], passed);
 * // [{ rule_id: 'BR-RUA-006', outcome: 'pass', case_ids: ['consistent'] }]
 */
export function ruleCoverage(
  declarations: readonly GoldenCaseDeclaration[],
  passedTests: readonly PassedSuiteTest[],
): readonly RuleCoverage[] {
  const passing = new Set(passedTests.filter((test) => isTrialOracleGolden(test.file)).map((test) => test.name));
  const cases = new Map<string, Set<string>>();
  for (const declaration of declarations.filter((candidate) => passing.has(candidate.case_id))) {
    for (const pair of declaration.rule_outcomes.filter(isRecordablePair)) {
      const key = `${pair.rule_id}=${pair.outcome}`;
      cases.set(key, (cases.get(key) ?? new Set<string>()).add(declaration.case_id));
    }
  }
  return VERDICT_CHANGING_RULES.flatMap((ruleId) =>
    [...cases.entries()]
      .filter(([key]) => key.startsWith(`${ruleId}=`))
      .map(([key, caseIds]) => ({
        rule_id: ruleId,
        outcome: key.slice(ruleId.length + 1),
        case_ids: [...caseIds].toSorted(),
      }))
      .toSorted((a, b) => (a.outcome < b.outcome ? -1 : 1)),
  );
}

function isTrialOracleGolden(file: string): boolean {
  return file.startsWith(TRIAL_ORACLE_GOLDEN_DIRECTORY) || file.includes(`/${TRIAL_ORACLE_GOLDEN_DIRECTORY}`);
}

function isRecordablePair(pair: { readonly rule_id: string; readonly outcome: string }): boolean {
  // Every verdict-changing id already matches the record's rule-id pattern; the outcome is
  // committed case text, so it is checked against the record's outcome pattern.
  return (VERDICT_CHANGING_RULES as readonly string[]).includes(pair.rule_id) && OUTCOME_PATTERN.test(pair.outcome);
}

function exitReasons(run: GoldenSuiteRun): readonly StructuredReason[] {
  return run.exit_code === 0
    ? []
    : [notFinal(`${boundedText(run.command)} exited ${String(run.exit_code)}; expected exit code 0`)];
}

function countReasons(report: SuiteReport): readonly StructuredReason[] {
  const { counts } = report;
  const reasons: StructuredReason[] = [];
  if (counts.tests < report.minimum) {
    reasons.push(
      notFinal(
        `${String(counts.tests)} golden tests ran; expected at least the summed minimum ${String(report.minimum)}`,
      ),
    );
  }
  const unfinished = counts.failed + counts.cancelled + counts.skipped + counts.todo;
  if (unfinished > 0) {
    reasons.push(
      notFinal(
        `${String(counts.failed)} failed, ${String(counts.cancelled)} cancelled, ${String(counts.skipped)} skipped and ` +
          `${String(counts.todo)} todo golden tests; expected none`,
      ),
    );
  }
  return reasons;
}

// The record states an exit code in 0..255; anything else (never produced by a process) reads 255.
function recordableExitCode(exitCode: number): number {
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= MAX_EXIT_CODE ? exitCode : MAX_EXIT_CODE;
}

function notFinal(detail: string): StructuredReason {
  return admissionReason(CODE, SUBJECT, detail);
}
