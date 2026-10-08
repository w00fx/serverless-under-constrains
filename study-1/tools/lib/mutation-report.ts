// The mutation gate of design §15.3 (testing rule 5). Stryker's score hides RuntimeError and
// CompileError, so the gate reads the JSON report and requires, per target file: no Survived
// and no Ignored mutant (unless a human-approved equivalence covers it), no NoCoverage, no
// RuntimeError, no Pending, and at least one valid mutant. CompileError mutants are invalid and
// never count as kills. An Ignored mutant is unresolved: a `// Stryker disable` comment or an
// ignorer must not stand in for the human decision quality/mutation-equivalences.json records
// (WP-00 review round 1). A file with zero valid mutants is unmeasured unless it has no runtime
// code at all; Timeouts are listed for review. A type-only module (no runtime code under type
// stripping) is excluded from the targets by the human decision A-10: its verdict is `excluded`,
// never missing or unmeasured, and it does not count as a measured file. Stryker's JSON report
// lists only files that have mutants, so a type-only target is judged the same whether the
// report omits it or lists it with no mutants (WP-00 review round 2). A type-only file whose
// mutants are only Ignored still fails: an exclusion never hides an unresolved mutant.

import { isTypeOnlyModule } from './source-imports.ts';

export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Timeout',
  'Ignored',
  'Pending',
] as const;
export type MutantStatus = (typeof MUTANT_STATUSES)[number];

export interface ReportedMutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly replacement?: string;
  readonly status: MutantStatus;
  readonly line: number;
  readonly column: number;
}

export interface ReportedFile {
  readonly path: string;
  readonly source: string;
  readonly mutants: readonly ReportedMutant[];
}

export interface Equivalence {
  readonly file: string;
  readonly mutator: string;
  readonly line: number;
  readonly column: number;
  readonly replacement: string;
  readonly approved_by?: string;
  readonly approved_at?: string;
  readonly rationale: string;
}

export type FileVerdictKind = 'passed' | 'failed' | 'excluded' | 'unmeasured' | 'missing';

/** Why an `excluded` file is not a mutation target. */
export const TYPE_ONLY_EXCLUSION = 'excluded by human decision A-10: a type-only module has no runtime code to mutate';

/** A mutation-target file the gate expects to judge, with its source text. */
export interface ExpectedTarget {
  readonly path: string;
  readonly source: string;
}

export interface FileVerdict {
  readonly path: string;
  readonly verdict: FileVerdictKind;
  readonly counts: Readonly<Record<MutantStatus, number>>;
  readonly valid: number;
  readonly accepted_equivalent: number;
  readonly problems: readonly string[];
  readonly timeouts: readonly string[];
  /** Present exactly for an `excluded` verdict: the decision that excludes the file. */
  readonly exclusion?: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly files: readonly FileVerdict[];
  readonly problems: readonly string[];
}

/** Statuses that are not valid mutation sites: neither kills nor counted as tested code. */
const INVALID_STATUSES: ReadonlySet<MutantStatus> = new Set(['CompileError', 'Ignored']);
/** Statuses that only an approved equivalence resolves. */
const EQUIVALENCE_STATUSES: ReadonlySet<MutantStatus> = new Set(['Survived', 'Ignored']);

/**
 * Reads the files and mutants of a Stryker mutation-testing JSON report.
 *
 * @example
 * const files = parseMutationReport(JSON.parse(readFileSync('reports/mutation/mutation.json', 'utf8')));
 */
export function parseMutationReport(report: unknown): readonly ReportedFile[] {
  const files = asRecord(fieldOf(report, 'files', 'mutation report'), 'mutation report files');
  return Object.entries(files).map(([path, file]) => {
    const source = fieldOf(file, 'source', `report file ${path}`);
    const mutants = fieldOf(file, 'mutants', `report file ${path}`);
    if (typeof source !== 'string' || !Array.isArray(mutants)) {
      throw new Error(
        `report file ${path} has source ${typeof source} and mutants ${typeof mutants}; expected a string and an array`,
      );
    }
    return { path, source, mutants: mutants.map((mutant: unknown) => toMutant(path, mutant)) };
  });
}

/**
 * Reads `quality/mutation-equivalences.json`: `{ "equivalences": [...] }`, written by humans only.
 *
 * @example
 * parseEquivalences({ equivalences: [] }); // []
 */
export function parseEquivalences(document: unknown): readonly Equivalence[] {
  const entries = fieldOf(document, 'equivalences', 'mutation equivalences');
  if (!Array.isArray(entries)) {
    throw new Error(`equivalences is ${JSON.stringify(entries)}; expected an array`);
  }
  return entries.map((entry: unknown, index) => {
    const value = entry as Partial<Equivalence> | null;
    const complete =
      value !== null &&
      typeof value.file === 'string' &&
      typeof value.mutator === 'string' &&
      typeof value.line === 'number' &&
      typeof value.column === 'number' &&
      typeof value.replacement === 'string' &&
      typeof value.rationale === 'string';
    if (!complete) {
      throw new Error(
        `equivalences[${String(index)}] is ${JSON.stringify(entry)}; expected file, mutator, line, column, replacement and rationale`,
      );
    }
    return value as Equivalence;
  });
}

/**
 * Applies the gate. `expectedTargets` lists the target files the gate must judge: one absent
 * from the report is `missing` when it has runtime code and `excluded` (A-10) when it has none.
 * The gate passes only when at least one file is measured, that is not excluded.
 *
 * @example
 * const parsing = { path: 'src/record-contract/parsing.ts', source: readFileSync(path, 'utf8') };
 * const result = evaluateMutationGate(files, equivalences, [parsing]);
 * process.exitCode = result.passed ? 0 : 1;
 */
export function evaluateMutationGate(
  files: readonly ReportedFile[],
  equivalences: readonly Equivalence[],
  expectedTargets: readonly ExpectedTarget[],
): GateResult {
  const verdicts = files.map((file) =>
    judgeFile(
      file,
      equivalences.filter((entry) => entry.file === file.path),
    ),
  );
  const reported = new Set(files.map((file) => file.path));
  const missing = expectedTargets.filter((target) => !reported.has(target.path)).map(unreportedFile);
  const pendingProblems = equivalences
    .filter((entry) => (entry.approved_by ?? '') === '' || (entry.approved_at ?? '') === '')
    .map(
      (entry) =>
        `pending equivalence ${entry.file}:${String(entry.line)}:${String(entry.column)} ${entry.mutator}; expected an authorized human decision (approved_by, approved_at)`,
    );
  const all = [...verdicts, ...missing];
  const failedFiles = all.filter(
    (verdict) => verdict.verdict === 'failed' || verdict.verdict === 'unmeasured' || verdict.verdict === 'missing',
  );
  const measured = all.filter((verdict) => verdict.verdict !== 'excluded').length;
  return {
    passed: failedFiles.length === 0 && pendingProblems.length === 0 && measured > 0,
    files: all,
    problems: [...coverageProblems(all.length, measured), ...pendingProblems],
  };
}

/**
 * The printed gate report: one line per file with its counts (or its exclusion), its problems
 * and timeouts, the gate problems, the A-10 exclusion count and the verdict.
 *
 * @example
 * for (const line of formatGateReport(result)) process.stdout.write(`${line}\n`);
 */
export function formatGateReport(result: GateResult): readonly string[] {
  const excluded = result.files.filter((file) => file.verdict === 'excluded').length;
  const measured = result.files.length - excluded;
  return [
    ...result.files.flatMap(fileReportLines),
    ...result.problems.map((problem) => `gate: ${problem}`),
    `type-only targets excluded by human decision A-10 (no runtime code; never missing or unmeasured): ${String(excluded)}`,
    `mutation gate: ${result.passed ? 'PASSED' : 'FAILED'} over ${String(measured)} measured file(s), ${String(excluded)} excluded (A-10)`,
  ];
}

function fileReportLines(file: FileVerdict): readonly string[] {
  const c = file.counts;
  const summary =
    file.exclusion ??
    `valid ${String(file.valid)}, killed ${String(c.Killed)}, timeout ${String(c.Timeout)}, ` +
      `survived ${String(c.Survived)} (accepted ${String(file.accepted_equivalent)}), no-coverage ${String(c.NoCoverage)}, ` +
      `runtime-error ${String(c.RuntimeError)}, compile-error ${String(c.CompileError)}, ignored ${String(c.Ignored)}, pending ${String(c.Pending)}`;
  return [
    `${file.verdict.padEnd(10)} ${file.path}: ${summary}`,
    ...file.problems.map((problem) => `    ${problem}`),
    ...file.timeouts.map((timeout) => `    review timeout: ${timeout}`),
  ];
}

function coverageProblems(files: number, measured: number): readonly string[] {
  if (files === 0) {
    return ['the report holds no target file; zero files is not verification'];
  }
  if (measured === 0) {
    return ['every target is excluded by human decision A-10; zero measured files is not verification'];
  }
  return [];
}

function judgeFile(file: ReportedFile, equivalences: readonly Equivalence[]): FileVerdict {
  const counts = countStatuses(file.mutants);
  const accepted = file.mutants.filter(
    (mutant) => EQUIVALENCE_STATUSES.has(mutant.status) && isApprovedEquivalent(mutant, equivalences),
  );
  const valid = file.mutants.filter((mutant) => !INVALID_STATUSES.has(mutant.status)).length;
  const problems = [
    ...file.mutants
      .filter((mutant) => EQUIVALENCE_STATUSES.has(mutant.status) && !accepted.includes(mutant))
      .map(
        (mutant) =>
          `${mutant.status} ${mutant.mutatorName} at ${String(mutant.line)}:${String(mutant.column)} -> ${JSON.stringify(mutant.replacement ?? '')}`,
      ),
    ...(['NoCoverage', 'RuntimeError', 'Pending'] as const)
      .filter((status) => counts[status] > 0)
      .map((status) => `${String(counts[status])} ${status} mutant(s); expected none`),
  ];
  const timeouts = file.mutants
    .filter((mutant) => mutant.status === 'Timeout')
    .map((mutant) => `${mutant.mutatorName} at ${String(mutant.line)}:${String(mutant.column)}`);
  const base = { path: file.path, counts, valid, accepted_equivalent: accepted.length, timeouts };
  if (valid === 0 && problems.length > 0) {
    return { ...base, verdict: 'failed', problems };
  }
  if (valid === 0) {
    return isTypeOnlyModule(file.source)
      ? { ...base, verdict: 'excluded', problems: [], exclusion: TYPE_ONLY_EXCLUSION }
      : {
          ...base,
          verdict: 'unmeasured',
          problems: ['zero valid mutants in a file with runtime code; zero valid sites is unmeasured'],
        };
  }
  return { ...base, verdict: problems.length === 0 ? 'passed' : 'failed', problems };
}

function isApprovedEquivalent(mutant: ReportedMutant, equivalences: readonly Equivalence[]): boolean {
  return equivalences.some(
    (entry) =>
      (entry.approved_by ?? '') !== '' &&
      (entry.approved_at ?? '') !== '' &&
      entry.mutator === mutant.mutatorName &&
      entry.line === mutant.line &&
      entry.column === mutant.column &&
      entry.replacement === (mutant.replacement ?? ''),
  );
}

function unreportedFile(target: ExpectedTarget): FileVerdict {
  const base = { path: target.path, counts: countStatuses([]), valid: 0, accepted_equivalent: 0, timeouts: [] };
  if (isTypeOnlyModule(target.source)) {
    return { ...base, verdict: 'excluded', problems: [], exclusion: TYPE_ONLY_EXCLUSION };
  }
  return {
    ...base,
    verdict: 'missing',
    problems: ['expected target file with runtime code is absent from the report; it was not mutated'],
  };
}

function countStatuses(mutants: readonly ReportedMutant[]): Readonly<Record<MutantStatus, number>> {
  const counts = Object.fromEntries(MUTANT_STATUSES.map((status) => [status, 0])) as Record<MutantStatus, number>;
  for (const mutant of mutants) {
    counts[mutant.status] += 1;
  }
  return counts;
}

function toMutant(path: string, raw: unknown): ReportedMutant {
  // A null or scalar entry is read as an empty object so it reaches the shape error below.
  const mutant = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    readonly id?: unknown;
    readonly mutatorName?: unknown;
    readonly replacement?: unknown;
    readonly status?: unknown;
    readonly location?: { readonly start?: { readonly line?: unknown; readonly column?: unknown } };
  };
  const start = mutant.location?.start;
  const status = mutant.status;
  const well =
    typeof mutant.id === 'string' &&
    typeof mutant.mutatorName === 'string' &&
    (MUTANT_STATUSES as readonly unknown[]).includes(status) &&
    typeof start?.line === 'number' &&
    typeof start.column === 'number';
  if (!well) {
    throw new Error(
      `report file ${path} holds mutant ${JSON.stringify(raw)}; expected id, mutatorName, a known status and location.start`,
    );
  }
  const base = {
    id: mutant.id,
    mutatorName: mutant.mutatorName,
    status: status as MutantStatus,
    line: start.line,
    column: start.column,
  };
  return typeof mutant.replacement === 'string' ? { ...base, replacement: mutant.replacement } : base;
}

function fieldOf(container: unknown, field: string, what: string): unknown {
  const record = asRecord(container, what);
  if (!(field in record)) {
    throw new Error(`${what} has no ${JSON.stringify(field)} field; expected it to be present`);
  }
  return record[field];
}

function asRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is ${JSON.stringify(value)}; expected a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}
