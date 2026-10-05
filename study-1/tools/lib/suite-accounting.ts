// Decisions behind `tools/run-suite.ts` (design §12.1, D-33; testing rules 7 and 8):
// `node --test` exits 0 on an empty glob, so the suite runner fails a run with zero tests,
// any failure or cancellation, any skip or todo, or fewer tests than the summed per-feature
// minimums. Minimum files only ratchet upward; this module only reads them.

export const SUITE_NAMES = ['unit', 'contract', 'golden', 'integration', 'fuzz', 'e2e'] as const;
export type SuiteName = (typeof SUITE_NAMES)[number];

export interface SuiteCounts {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
}

export interface SuiteVerdict {
  readonly exitCode: 0 | 1;
  readonly problems: readonly string[];
}

export type SuiteMinimums = Readonly<Partial<Record<SuiteName, number>>>;

/**
 * Validates one `quality/suite-minimums/<feature>.json` document.
 *
 * @example
 * parseSuiteMinimums('quality/suite-minimums/record-contract-kernel.json', { unit: 120 }); // { unit: 120 }
 */
export function parseSuiteMinimums(source: string, document: unknown): SuiteMinimums {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(
      `${source} holds ${JSON.stringify(document)}; expected an object of suite name to minimum test count`,
    );
  }
  const entries = Object.entries(document as Readonly<Record<string, unknown>>);
  for (const [suite, minimum] of entries) {
    if (!(SUITE_NAMES as readonly string[]).includes(suite)) {
      throw new Error(`${source} names suite ${JSON.stringify(suite)}; expected one of ${SUITE_NAMES.join(', ')}`);
    }
    if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0) {
      throw new Error(`${source} sets ${suite} to ${JSON.stringify(minimum)}; expected a nonnegative integer`);
    }
  }
  return document;
}

/**
 * Sums the minimum of one suite over every feature file; a suite name outside the
 * catalogue (such as `all` or `feature`) has no minimum beyond the zero-test guard.
 *
 * @example
 * sumSuiteMinimum([{ unit: 3 }, { unit: 4, fuzz: 1 }], 'unit'); // 7
 */
export function sumSuiteMinimum(files: readonly SuiteMinimums[], suite: string): number {
  if (!(SUITE_NAMES as readonly string[]).includes(suite)) {
    return 0;
  }
  return files.reduce((total, file) => total + (file[suite as SuiteName] ?? 0), 0);
}

/**
 * Judges a finished run.
 *
 * @example
 * evaluateSuiteRun('unit', counts, 120); // { exitCode: 0, problems: [] } when everything passed
 */
export function evaluateSuiteRun(suite: string, counts: SuiteCounts, minimum: number): SuiteVerdict {
  const problems: string[] = [];
  if (counts.tests === 0) {
    problems.push(`zero tests executed for suite ${suite}; zero tests is not verification`);
  }
  if (counts.failed > 0 || counts.cancelled > 0) {
    problems.push(`${String(counts.failed)} failed and ${String(counts.cancelled)} cancelled test(s); expected none`);
  }
  if (counts.skipped + counts.todo > 0) {
    problems.push(`${String(counts.skipped)} skipped and ${String(counts.todo)} todo test(s); expected none`);
  }
  if (counts.tests < minimum) {
    problems.push(`${String(counts.tests)} test(s) ran; expected at least the summed minimum ${String(minimum)}`);
  }
  return { exitCode: problems.length === 0 ? 0 : 1, problems };
}

/**
 * The e2e suite touches a real cloud account, so it refuses to start unless both opt-in
 * variables are set (design §14). Returns the refusal, or undefined when it may start.
 *
 * @example
 * e2eRefusal({ RUA_E2E_ENV: 'env.json' }); // 'e2e refuses to start: RUA_E2E_CONFIRM is not set ...'
 */
export function e2eRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const missing = ['RUA_E2E_ENV', 'RUA_E2E_CONFIRM'].filter((name) => (env[name] ?? '') === '');
  if (missing.length === 0) {
    return undefined;
  }
  return `e2e refuses to start: ${missing.join(' and ')} not set; expected RUA_E2E_ENV=<environment-input file> and RUA_E2E_CONFIRM=<execution_id>`;
}
