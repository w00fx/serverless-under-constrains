// The mutation gate of design §15.3 (testing rule 5). Stryker's score hides RuntimeError and
// CompileError, so the gate reads the JSON report and requires, per target file: no
// Survived (unless a human-approved equivalence covers it), no NoCoverage, no RuntimeError,
// no Pending, and at least one valid mutant. CompileError and Ignored mutants are invalid and
// never count as kills. A file with zero valid mutants is unmeasured unless it has no runtime
// code at all (type-only modules have nothing to mutate); Timeouts are listed for review.

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

export type FileVerdictKind = 'passed' | 'failed' | 'type_only' | 'unmeasured' | 'missing';

export interface FileVerdict {
  readonly path: string;
  readonly verdict: FileVerdictKind;
  readonly counts: Readonly<Record<MutantStatus, number>>;
  readonly valid: number;
  readonly accepted_equivalent: number;
  readonly problems: readonly string[];
  readonly timeouts: readonly string[];
}

export interface GateResult {
  readonly passed: boolean;
  readonly files: readonly FileVerdict[];
  readonly problems: readonly string[];
}

const INVALID_STATUSES: ReadonlySet<MutantStatus> = new Set(['CompileError', 'Ignored']);

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
 * Applies the gate. `expectedFiles` lists target files that must appear in the report.
 *
 * @example
 * const result = evaluateMutationGate(files, equivalences, ['src/record-contract/parsing.ts']);
 * process.exitCode = result.passed ? 0 : 1;
 */
export function evaluateMutationGate(
  files: readonly ReportedFile[],
  equivalences: readonly Equivalence[],
  expectedFiles: readonly string[],
): GateResult {
  const verdicts = files.map((file) =>
    judgeFile(
      file,
      equivalences.filter((entry) => entry.file === file.path),
    ),
  );
  const reported = new Set(files.map((file) => file.path));
  const missing = expectedFiles.filter((path) => !reported.has(path)).map((path) => missingFile(path));
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
  return {
    passed: failedFiles.length === 0 && pendingProblems.length === 0 && all.length > 0,
    files: all,
    problems: [
      ...(all.length === 0 ? ['the report holds no target file; zero files is not verification'] : []),
      ...pendingProblems,
    ],
  };
}

function judgeFile(file: ReportedFile, equivalences: readonly Equivalence[]): FileVerdict {
  const counts = countStatuses(file.mutants);
  const accepted = file.mutants.filter(
    (mutant) => mutant.status === 'Survived' && isApprovedEquivalent(mutant, equivalences),
  );
  const valid = file.mutants.filter((mutant) => !INVALID_STATUSES.has(mutant.status)).length;
  const problems = [
    ...file.mutants
      .filter((mutant) => mutant.status === 'Survived' && !accepted.includes(mutant))
      .map(
        (mutant) =>
          `Survived ${mutant.mutatorName} at ${String(mutant.line)}:${String(mutant.column)} -> ${JSON.stringify(mutant.replacement ?? '')}`,
      ),
    ...(['NoCoverage', 'RuntimeError', 'Pending'] as const)
      .filter((status) => counts[status] > 0)
      .map((status) => `${String(counts[status])} ${status} mutant(s); expected none`),
  ];
  const timeouts = file.mutants
    .filter((mutant) => mutant.status === 'Timeout')
    .map((mutant) => `${mutant.mutatorName} at ${String(mutant.line)}:${String(mutant.column)}`);
  const base = { path: file.path, counts, valid, accepted_equivalent: accepted.length, timeouts };
  if (valid === 0) {
    return isTypeOnlyModule(file.source)
      ? { ...base, verdict: 'type_only', problems: [] }
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

function missingFile(path: string): FileVerdict {
  return {
    path,
    verdict: 'missing',
    counts: countStatuses([]),
    valid: 0,
    accepted_equivalent: 0,
    problems: ['expected target file is absent from the report; it was not mutated'],
    timeouts: [],
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
