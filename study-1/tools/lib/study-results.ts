// The derived Study 1 results file (close-out Phase 1): the canonical run, the variant
// validations that count as within-variant reproductions, and the ones excluded with the reasons
// their own packages state. Every value comes from a package artifact or a verification record,
// and every artifact is cited with its digest. A reproduction is never comparative, with spec
// limitation 9 quoted from the spec itself. The raw packages stay the authority; this file is a
// derived view of them.

import type { ExcludedExecution, ExecutionInput, ExecutionResult } from './study-results-execution.ts';
import {
  deriveExcludedExecution,
  deriveExecutionResult,
  exactlyOne,
  REPRODUCTION_CRITERION,
} from './study-results-execution.ts';
import type { FinancialFixture } from './study-results-inputs.ts';
import { assertFixtureInputs } from './study-results-inputs.ts';

/** The whole derived results file. */
export interface StudyResults {
  readonly record_type: 'study_results';
  readonly schema_version: 1;
  readonly capability: 'CAP-RUA';
  readonly derived_by: string;
  readonly authority: string;
  readonly field_definitions: Readonly<Record<string, string>>;
  readonly canonical_runs: readonly ExecutionResult[];
  readonly within_variant_reproductions: readonly ExecutionResult[];
  readonly excluded_executions: readonly ExcludedExecution[];
}

/** Everything one derivation reads: the executions by role, spec limitation 9's text and OR-RUA-001. */
export interface StudyResultsInput {
  readonly runs: readonly ExecutionInput[];
  readonly validations: readonly ExecutionInput[];
  readonly excludedValidations: readonly ExecutionInput[];
  readonly limitation9: string;
  readonly financialFixture: FinancialFixture;
}

/** The parsed command line of tools/derive-study-results.ts. */
export interface DeriveArguments {
  readonly evidenceRoot: string;
  readonly spec: string;
  readonly runs: readonly string[];
  readonly validations: readonly string[];
  readonly excludedValidations: readonly string[];
  readonly out: string;
  /** The documents that hold the study block: the root README and the close-out note. */
  readonly readmes: readonly string[];
  readonly check: boolean;
}

const LIMITATIONS_HEADING = '## Threats to Validity and Limitations';
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALUE_FLAGS: readonly string[] = [
  '--evidence-root',
  '--spec',
  '--run',
  '--validation',
  '--excluded-validation',
  '--out',
  '--readme',
];
const USAGE =
  'node tools/derive-study-results.ts --evidence-root <dir> --spec <spec.md> --run <id> ' +
  '[--validation <id> ...] [--excluded-validation <id> ...] --out <results.json> --readme <file.md> ' +
  '[--readme <file.md> ...] [--check]';

export const FIELD_DEFINITIONS: Readonly<Record<string, string>> = {
  paths:
    'Every artifact path is relative to its package directory; package and verification paths are relative to the evidence root.',
  package_index_sha256: "SHA-256 of the package's package-index.json bytes: the package's identity.",
  inputs:
    "Approved and captured amounts in minor units of currency, and the Region: the execution manifest's, equal to each trial's payment and approved decision and to the spec's OR-RUA-001.",
  'safety.estimated_cost': "The safety assessment's pre-billing cost estimate (BR-RUA-046), not billed cost.",
  'safety.active_time': "The safety assessment's observed active time against its declared limit.",
  'trials[].preservation_verdict': "The frozen oracle result's verdict on the single-refund invariant.",
  'trials[].successful_transaction_count':
    'SUCCEEDED transactions in the frozen ledger snapshot, cross-checked with the oracle.',
  'trials[].refunded_total_minor': 'Sum of amount_minor over those transactions, in minor units of currency.',
  'trials[].commit_gap_seconds':
    'Seconds from the first to the second commit_requested_at; null with fewer than two commits.',
  'trials[].retry.source_receive_count': 'Highest approximate_receive_count over the caller journal invocations.',
  'trials[].retry.durable_step_attempt':
    'Highest step_attempt over the caller journal invocations; null for a conventional caller.',
  'trials[].retry.durable_executions':
    'Each Durable execution: its status, last history event and highest step attempt.',
  'trials[].retry.mechanism':
    'source_redelivery when receive count > 1; durable_step_retry when step attempt > 1; both or none.',
  within_variant_reproductions: `Variant validations: one variant each, never comparative (spec limitation 9). ${REPRODUCTION_CRITERION}`,
  excluded_executions:
    'Variant validations that fail that criterion: never counted, listed with the status reasons, unverified gates and indeterminate reason codes their own packages state.',
};

/**
 * The derived results of the given executions, each list in the order given.
 *
 * @example
 * deriveStudyResults({ runs: [run], validations, excludedValidations: [], limitation9, financialFixture })
 *   .canonical_runs[0].trials.length; // 4
 */
export function deriveStudyResults(input: StudyResultsInput): StudyResults {
  const counted = (one: ExecutionInput): ExecutionResult => {
    const result = deriveExecutionResult(one, input.limitation9);
    assertFixtureInputs(result.inputs, input.financialFixture, result.package_directory);
    return result;
  };
  return {
    record_type: 'study_results',
    schema_version: 1,
    capability: 'CAP-RUA',
    derived_by: 'study-1/tools/derive-study-results.ts',
    authority: "Each package's package-index.json digest is the authority; this file is a derived view.",
    field_definitions: FIELD_DEFINITIONS,
    canonical_runs: input.runs.map(counted),
    within_variant_reproductions: input.validations.map(counted),
    excluded_executions: input.excludedValidations.map(deriveExcludedExecution),
  };
}

/**
 * The text of numbered limitation `number` in the spec's limitations section.
 *
 * @example
 * limitationOf(specText, 9); // 'Variant-validation evidence is non-comparative and cannot substitute for …'
 */
export function limitationOf(specMarkdown: string, number: number): string {
  const prefix = `${String(number)}. `;
  // Every "## " heading opens a new section; only lines under the limitations heading count.
  let inLimitations = false;
  for (const line of specMarkdown.split('\n')) {
    if (line.startsWith('## ')) {
      inLimitations = line === LIMITATIONS_HEADING;
      continue;
    }
    if (inLimitations && line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  throw new Error(
    `the spec holds no limitation ${String(number)} under "${LIMITATIONS_HEADING}"; expected a line "${prefix}…"`,
  );
}

/**
 * The derived results as the committed file holds them: two-space JSON with a trailing newline.
 *
 * @example
 * writeFileSync(out, serializeStudyResults(results));
 */
export function serializeStudyResults(results: StudyResults): string {
  return `${JSON.stringify(results, null, 2)}\n`;
}

/**
 * The command line of tools/derive-study-results.ts, refused with the usage when malformed or
 * when one id is named twice.
 *
 * @example
 * parseDeriveArguments(['--evidence-root', 'evidence', '--spec', 's.md', '--run', id, '--out', 'r.json']).check; // false
 */
export function parseDeriveArguments(argv: readonly string[]): DeriveArguments {
  const values = new Map<string, string[]>();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      check = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === undefined || !VALUE_FLAGS.includes(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`usage: ${USAGE}; got ${JSON.stringify(argv)}`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const single = (flag: string): string => {
    const found = values.get(flag) ?? [];
    return exactlyOne(found, `usage: ${USAGE}; got ${JSON.stringify(argv)} with ${String(found.length)} ${flag}`);
  };
  const atLeastOne = (flag: string): readonly string[] => {
    const found = values.get(flag) ?? [];
    if (found.length === 0) {
      throw new Error(`usage: ${USAGE}; got ${JSON.stringify(argv)} with 0 ${flag}`);
    }
    return found;
  };
  const runs = values.get('--run') ?? [];
  const validations = values.get('--validation') ?? [];
  const excludedValidations = values.get('--excluded-validation') ?? [];
  const idRefusal = executionIdRefusal(runs, [...runs, ...validations, ...excludedValidations]);
  if (idRefusal !== undefined) {
    throw new Error(`usage: ${USAGE}; got ${JSON.stringify(argv)}; ${idRefusal}`);
  }
  return {
    evidenceRoot: single('--evidence-root'),
    spec: single('--spec'),
    runs,
    validations,
    excludedValidations,
    out: single('--out'),
    readmes: atLeastOne('--readme'),
    check,
  };
}

// Why the ids cannot name the packages, or undefined when they can: no run, an id that is not a
// lowercase UUID (a path such as ../x would leave the evidence root), or an id named twice.
function executionIdRefusal(runs: readonly string[], ids: readonly string[]): string | undefined {
  if (runs.length === 0) {
    return 'expected at least one --run';
  }
  const malformed = ids.filter((id) => !EXECUTION_ID.test(id));
  if (malformed.length > 0) {
    return `got malformed ids ${JSON.stringify(malformed)}; expected lowercase UUID ids`;
  }
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) {
    return `got repeated ids ${JSON.stringify(repeated)}; expected each id once`;
  }
  return undefined;
}
