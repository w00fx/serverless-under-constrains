// A total reader of the `--report-json` file `tools/run-suite.ts` writes (design §10.1 A9, D-18):
// `{suite, patterns, files, counts, minimum, exit_code, problems, passed_tests}`. The report is
// local tool output, but the oracle attestation must not trust a shape it did not check, so the
// bytes are parsed strictly (UTF-8 JSON) and every member is an own-property read with its type
// checked (A-05). Unknown members are tolerated: the runner may add diagnostics later, and none
// of them can make an unfinished oracle look final.

import { describeJson, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import { ownValue } from '../evidence-collection/sdk-values.ts';
import { describeParseFailure, ownField } from '../trial-message/trial-message-fields.ts';
import type { GoldenCaseDeclaration } from './admission-ports.ts';

export const SUITE_COUNT_NAMES = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'] as const;
export type SuiteCountName = (typeof SUITE_COUNT_NAMES)[number];

export interface PassedSuiteTest {
  readonly file: string;
  readonly name: string;
}

/** The members of a run-suite report the attestation judges. */
export interface SuiteReport {
  readonly suite: string;
  readonly counts: Readonly<Record<SuiteCountName, number>>;
  readonly minimum: number;
  readonly exit_code: number;
  readonly passed_tests: readonly PassedSuiteTest[];
}

/**
 * Parses report bytes; the error names the first member that is not as `tools/run-suite.ts` writes it.
 *
 * @example
 * parseSuiteReport(bytes); // { ok: true, value: { suite: 'golden', counts: { tests: 120, … }, … } }
 */
export function parseSuiteReport(bytes: Uint8Array): Result<SuiteReport, string> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return err(`the report is not one JSON document (${describeParseFailure(parsed.error)})`);
  }
  const report = parsed.value;
  if (!isJsonObject(report)) {
    return err(`the report is ${describeJson(report)}; expected a JSON object`);
  }
  const suite = ownField(report, 'suite');
  const counts = readCounts(ownField(report, 'counts'));
  const minimum = ownField(report, 'minimum');
  const exitCode = ownField(report, 'exit_code');
  const passedTests = readPassedTests(ownField(report, 'passed_tests'));
  if (typeof suite !== 'string') {
    return err(`suite is ${describeJson(suite)}; expected a string`);
  }
  if (!isCount(minimum) || !isCount(exitCode)) {
    return err(
      `minimum is ${describeJson(minimum)} and exit_code is ${describeJson(exitCode)}; expected two nonnegative safe integers`,
    );
  }
  if (!counts.ok) {
    return counts;
  }
  if (!passedTests.ok) {
    return passedTests;
  }
  return ok({ suite, counts: counts.value, minimum, exit_code: exitCode, passed_tests: passedTests.value });
}

function readCounts(value: JsonValue | undefined): Result<Readonly<Record<SuiteCountName, number>>, string> {
  if (!isJsonObject(value)) {
    return err(`counts is ${describeJson(value)}; expected an object of ${SUITE_COUNT_NAMES.join(', ')}`);
  }
  const counts: Partial<Record<SuiteCountName, number>> = {};
  for (const name of SUITE_COUNT_NAMES) {
    const count = ownField(value, name);
    if (!isCount(count)) {
      return err(`counts.${name} is ${describeJson(count)}; expected a nonnegative safe integer`);
    }
    counts[name] = count;
  }
  return ok(counts as Readonly<Record<SuiteCountName, number>>);
}

function readPassedTests(value: JsonValue | undefined): Result<readonly PassedSuiteTest[], string> {
  if (!isJsonArray(value)) {
    return err(`passed_tests is ${describeJson(value)}; expected an array of {file, name}`);
  }
  const tests: PassedSuiteTest[] = [];
  for (const [index, entry] of value.entries()) {
    const test = readPassedTest(entry);
    if (test === undefined) {
      return err(`passed_tests[${String(index)}] is ${describeJson(entry)}; expected {file: string, name: string}`);
    }
    tests.push(test);
  }
  return ok(tests);
}

function readPassedTest(entry: JsonValue): PassedSuiteTest | undefined {
  const object: JsonObject | undefined = isJsonObject(entry) ? entry : undefined;
  const file = object === undefined ? undefined : ownField(object, 'file');
  const name = object === undefined ? undefined : ownField(object, 'name');
  return typeof file === 'string' && typeof name === 'string' ? { file, name } : undefined;
}

function isCount(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The verdict-changing declaration of one golden case module's default export: its `case_id` and
 * `rule_outcomes_reached`; `undefined` for anything else, so an unreadable case covers nothing.
 *
 * @example
 * caseDeclarationOf({ case_id: 'consistent', rule_outcomes_reached: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }] });
 */
export function caseDeclarationOf(value: unknown): GoldenCaseDeclaration | undefined {
  const caseId = ownValue(value, 'case_id');
  const declared = ownValue(value, 'rule_outcomes_reached');
  if (typeof caseId !== 'string' || !Array.isArray(declared)) {
    return undefined;
  }
  const pairs = declared.map((pair: unknown) => ({
    rule_id: ownValue(pair, 'rule_id'),
    outcome: ownValue(pair, 'outcome'),
  }));
  const readable = pairs.filter(
    (pair): pair is { readonly rule_id: string; readonly outcome: string } =>
      typeof pair.rule_id === 'string' && typeof pair.outcome === 'string',
  );
  return readable.length === pairs.length ? { case_id: caseId, rule_outcomes: readable } : undefined;
}
