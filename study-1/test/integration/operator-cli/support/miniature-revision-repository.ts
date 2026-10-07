// A real git repository whose `study-1/` holds a miniature, runnable golden suite (design §10.1
// A9): a `package.json` whose `test:golden` script runs this repository's `tools/run-suite.ts`,
// an installable lockfile, a golden minimum, and one trial-oracle golden case per verdict-changing
// rule with its `cases/*.case.ts` declaration. Two commits: `final` (every case passes) and
// `regressed` (one case fails). It is a harness over real git and npm, not a fake.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERDICT_CHANGING_RULES } from '../../../../src/trial-oracle/oracle-vocabulary.ts';
import { TemporaryGitWorkTree } from '../../../support/admission/temporary-git-work-tree.ts';

const RUN_SUITE = fileURLToPath(new URL('../../../../tools/run-suite.ts', import.meta.url));
const LOCKFILE = `${JSON.stringify(
  { name: 'miniature-study', lockfileVersion: 3, requires: true, packages: { '': { name: 'miniature-study' } } },
  null,
  2,
)}\n`;

/** The case id of a rule's miniature golden case. */
export function miniatureCaseId(ruleId: string): string {
  return `covers-${ruleId.toLowerCase()}`;
}

export class MiniatureRevisionRepository {
  readonly tree: TemporaryGitWorkTree;
  /** Every case passes at this commit. */
  readonly final_commit: string;
  readonly final_tree: string;
  /** One case fails at this commit. */
  readonly regressed_commit: string;

  private constructor(tree: TemporaryGitWorkTree, final: readonly [string, string], regressed: string) {
    this.tree = tree;
    [this.final_commit, this.final_tree] = final;
    this.regressed_commit = regressed;
  }

  static create(): MiniatureRevisionRepository {
    const tree = TemporaryGitWorkTree.create();
    tree.write(
      'study-1/package.json',
      JSON.stringify({
        name: 'miniature-study',
        private: true,
        type: 'module',
        scripts: { 'test:golden': `node ${JSON.stringify(RUN_SUITE)} golden "test/golden/**/*.golden.test.ts"` },
      }),
    );
    tree.write('study-1/package-lock.json', LOCKFILE);
    tree.write(
      'study-1/quality/suite-minimums/miniature.json',
      JSON.stringify({ golden: VERDICT_CHANGING_RULES.length }),
    );
    for (const ruleId of VERDICT_CHANGING_RULES) {
      const declaration = {
        case_id: miniatureCaseId(ruleId),
        rule_outcomes_reached: [{ rule_id: ruleId, outcome: 'pass' }],
      };
      tree.write(
        `study-1/test/golden/trial-oracle/miniature/cases/${miniatureCaseId(ruleId)}.case.ts`,
        `export default ${JSON.stringify(declaration)};\n`,
      );
    }
    writeGoldenFile(tree, undefined);
    tree.commit('miniature golden suite');
    const final = [tree.head(), tree.tree()] as const;
    writeGoldenFile(tree, VERDICT_CHANGING_RULES[0]);
    tree.commit('seed a golden regression');
    return new MiniatureRevisionRepository(tree, final, tree.head());
  }

  /** The study root of the operator's work tree. */
  get studyRoot(): string {
    return join(this.tree.root, 'study-1');
  }

  dispose(): void {
    this.tree.dispose();
  }
}

// One golden file with a test per case; the case of `failing` asserts a false fact.
function writeGoldenFile(tree: TemporaryGitWorkTree, failing: string | undefined): void {
  const tests = VERDICT_CHANGING_RULES.map(
    (ruleId) =>
      `it(${JSON.stringify(miniatureCaseId(ruleId))}, () => { assert.equal(${String(ruleId !== failing)}, true); });`,
  );
  tree.write(
    'study-1/test/golden/trial-oracle/miniature/miniature.golden.test.ts',
    `import assert from 'node:assert/strict';\nimport { it } from 'node:test';\n${tests.join('\n')}\n`,
  );
}
