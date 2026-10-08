// FakeGoldenSuiteRunner (design §12.2): the golden-suite port with a scripted run. It emulates
// `GoldenSuiteReader` over `tools/run-suite.ts`: the report bytes are the JSON document the runner
// writes (`suite`, `patterns`, `files`, `counts`, `minimum`, `exit_code`, `problems`,
// `passed_tests` with absolute file paths), the exit code is the runner's, and the case
// declarations are the trial-oracle cases' default exports. By default one passing case per
// verdict-changing rule covers every rule and the run is final. Its conformance test runs the
// production reader over a real temporary golden suite and compares what A9 concludes.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type {
  GoldenCaseDeclaration,
  GoldenSuiteReadPort,
  GoldenSuiteRun,
  PortFailure,
  PortResult,
} from '../../../src/admission/admission-ports.ts';
import { VERDICT_CHANGING_RULES } from '../../../src/trial-oracle/oracle-vocabulary.ts';

export const FAKE_GOLDEN_FILE = '/study/test/golden/trial-oracle/integrity/verdict-rule-coverage.golden.test.ts';
export const FAKE_GOLDEN_COMMAND = 'npm run test:golden -- --report-json /tmp/suc-golden/report.json';

/**
 * The case id the fake declares for a rule.
 *
 * @example
 * coverageCaseId('BR-RUA-006'); // 'covers-br-rua-006'
 */
export function coverageCaseId(ruleId: string): string {
  return `covers-${ruleId.toLowerCase()}`;
}

/**
 * A scripted golden run; final and fully covering by default.
 *
 * @example
 * const golden = new FakeGoldenSuiteRunner();
 * golden.failTests(1);
 * (await golden.readGoldenSuiteRun()).value.exit_code; // 1
 */
export class FakeGoldenSuiteRunner implements GoldenSuiteReadPort {
  readonly #uncovered = new Set<string>();
  #failedTests = 0;
  #exitCode: number | undefined;
  #minimum: number | undefined;
  #reportBytes: Uint8Array | undefined;
  #failure: PortFailure | undefined;
  #runs = 0;

  /** The next runs report `count` failing golden tests and exit 1. */
  failTests(count: number): void {
    this.#failedTests = count;
  }

  /** No committed case declares `ruleId` any more. */
  uncover(ruleId: string): void {
    this.#uncovered.add(ruleId);
  }

  /** The runner exits with `code` whatever the counts say. */
  exitWith(code: number): void {
    this.#exitCode = code;
  }

  /** The summed golden minimum the report states (the passing count by default). */
  requireMinimum(minimum: number): void {
    this.#minimum = minimum;
  }

  /** The report file holds exactly these bytes. */
  writeReport(bytes: Uint8Array): void {
    this.#reportBytes = bytes;
  }

  /** Every later run fails before a report exists. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  /** How many times the suite ran. */
  runCount(): number {
    return this.#runs;
  }

  readGoldenSuiteRun(): PortResult<GoldenSuiteRun> {
    this.#runs += 1;
    if (this.#failure !== undefined) {
      return Promise.resolve(err(this.#failure));
    }
    const declarations = this.#declarations();
    const passing = declarations.map((declaration) => ({ file: FAKE_GOLDEN_FILE, name: declaration.case_id }));
    const tests = passing.length + this.#failedTests;
    const exitCode = this.#exitCode ?? (this.#failedTests > 0 ? 1 : 0);
    const report = {
      suite: 'golden',
      patterns: ['test/golden/**/*.golden.test.ts'],
      files: [FAKE_GOLDEN_FILE],
      counts: { tests, passed: passing.length, failed: this.#failedTests, cancelled: 0, skipped: 0, todo: 0 },
      minimum: this.#minimum ?? passing.length,
      exit_code: exitCode,
      problems: this.#failedTests > 0 ? [`${String(this.#failedTests)} test(s) failed or were cancelled`] : [],
      passed_tests: passing,
    };
    return Promise.resolve(
      ok({
        command: FAKE_GOLDEN_COMMAND,
        exit_code: exitCode,
        report_bytes: this.#reportBytes ?? new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
        case_declarations: declarations,
      }),
    );
  }

  #declarations(): readonly GoldenCaseDeclaration[] {
    return VERDICT_CHANGING_RULES.filter((ruleId) => !this.#uncovered.has(ruleId)).map((ruleId) => ({
      case_id: coverageCaseId(ruleId),
      rule_outcomes: [{ rule_id: ruleId, outcome: 'pass' }],
    }));
  }
}
