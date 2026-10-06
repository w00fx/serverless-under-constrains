// A real miniature golden suite in a temporary study root (design §10.1 A9, D-18): a
// `package.json` whose `test:golden` script runs this repository's `tools/run-suite.ts`, a summed
// golden minimum, and trial-oracle golden files with their `cases/*.case.ts` declarations. The
// production `GoldenSuiteReader` runs `npm run test:golden -- --report-json` there unchanged.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_SUITE = fileURLToPath(new URL('../../../tools/run-suite.ts', import.meta.url));

/** One golden case: its id, the rule it declares and whether its test passes. */
export interface MiniatureGoldenCase {
  readonly case_id: string;
  readonly rule_id: string;
  readonly passes: boolean;
}

/**
 * A temporary study root holding a runnable golden suite.
 *
 * @example
 * const suite = TemporaryGoldenSuite.create([{ case_id: 'covers-traceability', rule_id: 'traceability', passes: true }]);
 * suite.dispose();
 */
export class TemporaryGoldenSuite {
  readonly studyRoot: string;

  private constructor(studyRoot: string) {
    this.studyRoot = studyRoot;
  }

  /** Writes the package script, the minimum and one golden file with every case. */
  static create(cases: readonly MiniatureGoldenCase[], minimum: number = cases.length): TemporaryGoldenSuite {
    const suite = new TemporaryGoldenSuite(mkdtempSync(join(tmpdir(), 'rua-admission-golden-')));
    suite.#write(
      'package.json',
      JSON.stringify({
        name: 'miniature-study',
        private: true,
        type: 'module',
        scripts: { 'test:golden': `node ${JSON.stringify(RUN_SUITE)} golden "test/golden/**/*.golden.test.ts"` },
      }),
    );
    suite.#write('quality/suite-minimums/miniature.json', JSON.stringify({ golden: minimum }));
    const tests = cases.map(
      (goldenCase) =>
        `it(${JSON.stringify(goldenCase.case_id)}, () => { assert.equal(${String(goldenCase.passes)}, true); });`,
    );
    suite.#write(
      'test/golden/trial-oracle/miniature/miniature.golden.test.ts',
      `import assert from 'node:assert/strict';\nimport { it } from 'node:test';\n${tests.join('\n')}\n`,
    );
    for (const goldenCase of cases) {
      const declaration = {
        case_id: goldenCase.case_id,
        rule_outcomes_reached: [{ rule_id: goldenCase.rule_id, outcome: 'pass' }],
      };
      suite.#write(
        `test/golden/trial-oracle/miniature/cases/${goldenCase.case_id}.case.ts`,
        `export default ${JSON.stringify(declaration)};\n`,
      );
    }
    return suite;
  }

  /** Where the report is written: outside the study root's evidence, inside its scratch. */
  get reportPath(): string {
    return join(this.studyRoot, 'scratch', 'golden-report.json');
  }

  dispose(): void {
    rmSync(this.studyRoot, { recursive: true, force: true });
  }

  #write(path: string, content: string): void {
    const target = join(this.studyRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
