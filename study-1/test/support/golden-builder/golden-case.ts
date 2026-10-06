// The golden case contract (design §12.4): a `test/golden/<feature>/**/cases/<case-id>.case.ts`
// module default-exports `defineGoldenCase({...})`. A case names the base scenario it starts from,
// optionally the subject trial's plan, the scenario operations that state its fault, the
// acceptance criteria it serves, the rule outcomes it reaches (read by the AC-RUA-055 coverage
// golden), and its expected values, written from the spec and never copied from oracle output.
// The fixture generator and the harness accept a case only through `parseGoldenCase`, which is
// total over whatever a module exports.

import type { JsonValue, Result } from '../../../src/record-contract/primitives.ts';
import { PROVIDER_REJECTION_REASONS } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { Problems } from './case-reading.ts';
import { readArray, readChoice, readInteger, readJson, readMember, readObject, readString } from './case-reading.ts';
import type { AttemptPlan, BaseScenarioId, DeliveryPlan, TrialPlan } from './golden-plan.ts';
import { ATTEMPT_BEHAVIORS, BASE_SCENARIO_IDS, PROCESSING_ENDINGS } from './golden-plan.ts';
import { parseOperations } from './operation-parsing.ts';
import type { ScenarioOperation } from './operation-parsing.ts';

/** A case id: lowercase kebab-case, equal to the case file's base name. */
export const CASE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AC_ID_PATTERN = /^AC-RUA-\d{3}$/;
/** A rule, gate or condition id: `BR-RUA-001`, `INV-RUA-001`, `independent_oracle`. */
const RULE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** An outcome or gate value: `pass`, `fail`, `indeterminate`, `not_applicable`, `verified`, ... */
const OUTCOME_PATTERN = /^[a-z][a-z_]*$/;
/** Any text: plan values are checked against the architecture by `checkTrialPlan` at build time. */
const TEXT_PATTERN = /^[\s\S]*$/u;

/** One outcome a rule or gate reaches in a case (AC-RUA-055 coverage). */
export interface RuleOutcomeReached {
  readonly rule_id: string;
  readonly outcome: string;
}

/** A parsed, typed golden case. */
export interface GoldenCase {
  readonly case_id: string;
  readonly ac_ids: readonly string[];
  readonly rule_outcomes_reached: readonly RuleOutcomeReached[];
  readonly base: BaseScenarioId;
  readonly plan?: TrialPlan;
  readonly operations: readonly ScenarioOperation[];
  readonly expected: JsonValue;
}

/** What a case module writes: `operations` may be omitted when the base itself is the case. */
export type GoldenCaseDefinition = Omit<GoldenCase, 'operations'> & {
  readonly operations?: readonly ScenarioOperation[];
};

/**
 * Declares a golden case with its types checked at compile time; the module default-exports the
 * result.
 *
 * @example
 * export default defineGoldenCase({
 *   case_id: 'conventional-control-pass', ac_ids: ['AC-RUA-001'],
 *   rule_outcomes_reached: [{ rule_id: 'BR-RUA-001', outcome: 'pass' }],
 *   base: 'run-conventional-control', expected: { preservation_verdict: 'pass' },
 * });
 */
export function defineGoldenCase(definition: GoldenCaseDefinition): GoldenCase {
  return { ...definition, operations: definition.operations ?? [] };
}

/**
 * Checks an untrusted case value field by field; every problem names its location, the offending
 * value and the expected shape. Never throws.
 *
 * @example
 * const parsed = parseGoldenCase(module.default);
 * if (!parsed.ok) console.error(parsed.error.join('\n'));
 */
export function parseGoldenCase(value: unknown): Result<GoldenCase, readonly string[]> {
  const problems: Problems = [];
  const fields = readObject(
    value,
    'case',
    ['case_id', 'ac_ids', 'rule_outcomes_reached', 'base', 'operations', 'expected'],
    ['plan'],
    problems,
  );
  if (fields === undefined) {
    return { ok: false, error: problems };
  }
  const caseId = readMember(fields, 'case_id', (raw) => readString(raw, 'case.case_id', CASE_ID_PATTERN, problems));
  const acIds = readMember(fields, 'ac_ids', (raw) => parseAcIds(raw, problems));
  const outcomes = readMember(fields, 'rule_outcomes_reached', (raw) => parseRuleOutcomes(raw, problems));
  const base = readMember(fields, 'base', (raw) => readChoice(raw, 'case.base', BASE_SCENARIO_IDS, problems));
  const plan = readMember(fields, 'plan', (raw) => parsePlan(raw, 'case.plan', problems));
  const operations = readMember(fields, 'operations', (raw) => parseOperations(raw, 'case.operations', problems));
  const expected = readMember(fields, 'expected', (raw) => readJson(raw, 'case.expected', problems));
  if (
    problems.length > 0 ||
    caseId === undefined ||
    acIds === undefined ||
    outcomes === undefined ||
    base === undefined ||
    operations === undefined ||
    expected === undefined
  ) {
    return { ok: false, error: problems };
  }
  return {
    ok: true,
    value: {
      case_id: caseId,
      ac_ids: acIds,
      rule_outcomes_reached: outcomes,
      base,
      ...(plan === undefined ? {} : { plan }),
      operations,
      expected,
    },
  };
}

function parseAcIds(value: unknown, problems: Problems): readonly string[] | undefined {
  const items = readArray(value, 'case.ac_ids', problems);
  const ids = items?.map((item, index) => readString(item, `case.ac_ids[${String(index)}]`, AC_ID_PATTERN, problems));
  if (ids === undefined || ids.some((id) => id === undefined)) {
    return undefined;
  }
  const unique = ids.filter((id): id is string => id !== undefined);
  if (new Set(unique).size !== unique.length) {
    problems.push(`case.ac_ids ${JSON.stringify(unique)} repeats an id; expected unique ids`);
    return undefined;
  }
  return unique;
}

function parseRuleOutcomes(value: unknown, problems: Problems): readonly RuleOutcomeReached[] | undefined {
  const items = readArray(value, 'case.rule_outcomes_reached', problems);
  if (items === undefined) {
    return undefined;
  }
  const before = problems.length;
  const outcomes = items.map((item, index): RuleOutcomeReached | undefined => {
    const at = `case.rule_outcomes_reached[${String(index)}]`;
    const fields = readObject(item, at, ['rule_id', 'outcome'], [], problems);
    if (fields === undefined) {
      return undefined;
    }
    const ruleId = readMember(fields, 'rule_id', (raw) => readString(raw, `${at}.rule_id`, RULE_ID_PATTERN, problems));
    const outcome = readMember(fields, 'outcome', (raw) => readString(raw, `${at}.outcome`, OUTCOME_PATTERN, problems));
    return ruleId === undefined || outcome === undefined ? undefined : { rule_id: ruleId, outcome };
  });
  return problems.length === before
    ? outcomes.filter((outcome): outcome is RuleOutcomeReached => outcome !== undefined)
    : undefined;
}

/**
 * Parses a trial plan's shape; whether the architecture could run it is `checkTrialPlan`'s
 * question, asked when the scenario is built.
 *
 * @example
 * parsePlan({ deliveries: [{ attempts: [{ behavior: 'succeeded' }] }], processing: 'completes' }, 'case.plan', problems);
 */
export function parsePlan(value: unknown, at: string, problems: Problems): TrialPlan | undefined {
  const before = problems.length;
  const fields = readObject(value, at, ['deliveries', 'processing'], [], problems);
  if (fields === undefined) {
    return undefined;
  }
  const processing = readMember(fields, 'processing', (raw) =>
    readChoice(raw, `${at}.processing`, PROCESSING_ENDINGS, problems),
  );
  const items = readMember(fields, 'deliveries', (raw) => readArray(raw, `${at}.deliveries`, problems));
  const deliveries = items?.map((item, index) => parseDelivery(item, `${at}.deliveries[${String(index)}]`, problems));
  if (processing === undefined || deliveries === undefined || problems.length > before) {
    return undefined;
  }
  return { deliveries: deliveries.filter((delivery): delivery is DeliveryPlan => delivery !== undefined), processing };
}

function parseDelivery(value: unknown, at: string, problems: Problems): DeliveryPlan | undefined {
  const before = problems.length;
  const fields = readObject(value, at, ['attempts'], [], problems);
  const items =
    fields === undefined
      ? undefined
      : readMember(fields, 'attempts', (raw) => readArray(raw, `${at}.attempts`, problems));
  const attempts = items?.map((item, index) => parseAttempt(item, `${at}.attempts[${String(index)}]`, problems));
  if (attempts === undefined || problems.length > before) {
    return undefined;
  }
  return { attempts: attempts.filter((attempt): attempt is AttemptPlan => attempt !== undefined) };
}

const ATTEMPT_OPTIONAL_FIELDS = [
  'amount_minor',
  'currency',
  'refund_request_id',
  'payment_id',
  'rejection_reason',
] as const;

function parseAttempt(value: unknown, at: string, problems: Problems): AttemptPlan | undefined {
  const before = problems.length;
  const fields = readObject(value, at, ['behavior'], ATTEMPT_OPTIONAL_FIELDS, problems);
  if (fields === undefined) {
    return undefined;
  }
  const behavior = readMember(fields, 'behavior', (raw) =>
    readChoice(raw, `${at}.behavior`, ATTEMPT_BEHAVIORS, problems),
  );
  const optional = <T>(
    key: string,
    read: (raw: unknown, where: string) => T | undefined,
  ): Partial<Record<string, T>> => {
    if (!fields.has(key)) {
      return {};
    }
    const parsed = read(fields.get(key), `${at}.${key}`);
    return parsed === undefined ? {} : { [key]: parsed };
  };
  const plan = {
    behavior,
    ...optional('amount_minor', (raw, where) => readInteger(raw, where, Number.MIN_SAFE_INTEGER, problems)),
    ...optional('currency', (raw, where) => readString(raw, where, TEXT_PATTERN, problems)),
    ...optional('refund_request_id', (raw, where) => readString(raw, where, TEXT_PATTERN, problems)),
    ...optional('payment_id', (raw, where) => readString(raw, where, TEXT_PATTERN, problems)),
    ...optional('rejection_reason', (raw, where) => readChoice(raw, where, PROVIDER_REJECTION_REASONS, problems)),
  };
  return behavior === undefined || problems.length > before ? undefined : (plan as AttemptPlan);
}
