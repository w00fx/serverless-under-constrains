// The mutation gate of design §15.3 (testing rule 5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MUTANT_STATUSES,
  evaluateMutationGate,
  parseEquivalences,
  parseMutationReport,
} from '../../../tools/lib/mutation-report.ts';
import type {
  Equivalence,
  ExpectedTarget,
  MutantStatus,
  ReportedFile,
  ReportedMutant,
} from '../../../tools/lib/mutation-report.ts';

const RUNTIME_SOURCE = 'export const a = 1;';

function mutant(status: MutantStatus, line = 1, replacement = '0'): ReportedMutant {
  return { id: `${status}-${String(line)}`, mutatorName: 'NumericLiteral', replacement, status, line, column: 17 };
}

function reported(path: string, statuses: readonly MutantStatus[], source = RUNTIME_SOURCE): ReportedFile {
  return { path, source, mutants: statuses.map((status, index) => mutant(status, index + 1)) };
}

/** Expected targets that have runtime code, so one the report lacks is missing. */
function runtimeTargets(...paths: readonly string[]): readonly ExpectedTarget[] {
  return paths.map((path) => ({ path, source: RUNTIME_SOURCE }));
}

const approved: Equivalence = {
  file: 'src/a.ts',
  mutator: 'NumericLiteral',
  line: 2,
  column: 17,
  replacement: '0',
  approved_by: 'reviewer',
  approved_at: '2026-10-05T00:00:00.000Z',
  rationale: 'equivalent',
};

describe('parseMutationReport', () => {
  it('reads files and mutants from a Stryker JSON report', () => {
    const report = {
      schemaVersion: '2',
      files: {
        'src/a.ts': {
          language: 'typescript',
          source: RUNTIME_SOURCE,
          mutants: [
            {
              id: '1',
              mutatorName: 'NumericLiteral',
              replacement: '0',
              status: 'Killed',
              location: { start: { line: 1, column: 17 }, end: { line: 1, column: 18 } },
            },
            { id: '2', mutatorName: 'BlockStatement', status: 'Survived', location: { start: { line: 3, column: 1 } } },
          ],
        },
      },
    };
    assert.deepEqual(parseMutationReport(report), [
      {
        path: 'src/a.ts',
        source: RUNTIME_SOURCE,
        mutants: [
          { id: '1', mutatorName: 'NumericLiteral', replacement: '0', status: 'Killed', line: 1, column: 17 },
          { id: '2', mutatorName: 'BlockStatement', status: 'Survived', line: 3, column: 1 },
        ],
      },
    ]);
  });

  it('refuses malformed reports, naming the offending part', () => {
    assert.throws(() => parseMutationReport(null), { message: 'mutation report is null; expected a JSON object' });
    assert.throws(() => parseMutationReport([]), { message: 'mutation report is []; expected a JSON object' });
    assert.throws(() => parseMutationReport({}), {
      message: 'mutation report has no "files" field; expected it to be present',
    });
    assert.throws(() => parseMutationReport({ files: 'x' }), {
      message: 'mutation report files is "x"; expected a JSON object',
    });
    assert.throws(() => parseMutationReport({ files: { 'a.ts': { mutants: [] } } }), {
      message: 'report file a.ts has no "source" field; expected it to be present',
    });
    assert.throws(() => parseMutationReport({ files: { 'a.ts': { source: 1, mutants: [] } } }), {
      message: 'report file a.ts has source number and mutants object; expected a string and an array',
    });
    assert.throws(() => parseMutationReport({ files: { 'a.ts': { source: '', mutants: {} } } }), {
      message: 'report file a.ts has source string and mutants object; expected a string and an array',
    });
  });

  it('refuses a mutant without id, mutator, known status or start location', () => {
    const good = { id: '1', mutatorName: 'M', status: 'Killed', location: { start: { line: 1, column: 1 } } };
    const broken = [
      { ...good, id: 1 },
      { ...good, mutatorName: undefined },
      { ...good, status: 'Exploded' },
      { ...good, location: { start: { line: '1', column: 1 } } },
      { ...good, location: { start: { line: 1 } } },
      { ...good, location: {} },
      { id: '1', mutatorName: 'M', status: 'Killed' },
      null,
      'Killed',
    ];
    for (const raw of broken) {
      assert.throws(() => parseMutationReport({ files: { 'a.ts': { source: '', mutants: [raw] } } }), {
        message: `report file a.ts holds mutant ${JSON.stringify(raw)}; expected id, mutatorName, a known status and location.start`,
      });
    }
    assert.equal(MUTANT_STATUSES.length, 8);
  });
});

describe('parseEquivalences', () => {
  it('reads complete entries', () => {
    assert.deepEqual(parseEquivalences({ equivalences: [] }), []);
    assert.deepEqual(parseEquivalences({ equivalences: [approved] }), [approved]);
  });

  it('refuses incomplete entries and missing lists', () => {
    assert.throws(() => parseEquivalences({}), {
      message: 'mutation equivalences has no "equivalences" field; expected it to be present',
    });
    assert.throws(() => parseEquivalences({ equivalences: {} }), { message: 'equivalences is {}; expected an array' });
    const expectedShape = 'expected file, mutator, line, column, replacement and rationale';
    for (const field of ['file', 'mutator', 'line', 'column', 'replacement', 'rationale'] as const) {
      const { [field]: _dropped, ...entry } = approved;
      assert.throws(() => parseEquivalences({ equivalences: [entry] }), {
        message: `equivalences[0] is ${JSON.stringify(entry)}; ${expectedShape}`,
      });
    }
    assert.throws(() => parseEquivalences({ equivalences: [approved, null] }), {
      message: `equivalences[1] is null; ${expectedShape}`,
    });
  });
});

describe('evaluateMutationGate', () => {
  it('passes files whose valid mutants are all killed or timed out', () => {
    const result = evaluateMutationGate(
      [reported('src/a.ts', ['Killed', 'Killed', 'Timeout', 'CompileError'])],
      [],
      runtimeTargets('src/a.ts'),
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.problems, []);
    const [verdict] = result.files;
    assert.equal(verdict?.verdict, 'passed');
    assert.equal(verdict.valid, 3);
    assert.deepEqual(verdict.timeouts, ['NumericLiteral at 3:17']);
    assert.deepEqual(verdict.counts, {
      Killed: 2,
      Survived: 0,
      NoCoverage: 0,
      CompileError: 1,
      RuntimeError: 0,
      Timeout: 1,
      Ignored: 0,
      Pending: 0,
    });
  });

  it('fails an Ignored mutant unless an approved equivalence covers it (review round 1)', () => {
    // A `// Stryker disable` comment must not replace the human decision the equivalence file records.
    const ignored = reported('src/a.ts', ['Killed', 'Ignored']);
    const unresolved = evaluateMutationGate([ignored], [], runtimeTargets('src/a.ts'));
    assert.equal(unresolved.passed, false);
    assert.equal(unresolved.files[0]?.verdict, 'failed');
    assert.deepEqual(unresolved.files[0].problems, ['Ignored NumericLiteral at 2:17 -> "0"']);
    assert.equal(unresolved.files[0].valid, 1);
    const covered = evaluateMutationGate([ignored], [approved], runtimeTargets('src/a.ts'));
    assert.equal(covered.passed, true);
    assert.equal(covered.files[0]?.verdict, 'passed');
    assert.equal(covered.files[0].accepted_equivalent, 1);
    assert.equal(evaluateMutationGate([ignored], [{ ...approved, approved_by: '' }], []).files[0]?.verdict, 'failed');
  });

  it('fails a file whose only mutants are Ignored, even a type-only one, instead of calling it unmeasured', () => {
    const onlyIgnored = evaluateMutationGate([reported('src/a.ts', ['Ignored'])], [], []);
    assert.equal(onlyIgnored.files[0]?.verdict, 'failed');
    assert.deepEqual(onlyIgnored.files[0].problems, ['Ignored NumericLiteral at 1:17 -> "0"']);
    const typeOnly = evaluateMutationGate([reported('src/t.ts', ['Ignored'], 'export type T = 1;')], [], []);
    assert.equal(typeOnly.files[0]?.verdict, 'failed');
    const approvedOnly = evaluateMutationGate([reported('src/a.ts', ['Ignored'])], [{ ...approved, line: 1 }], []);
    assert.equal(approvedOnly.files[0]?.verdict, 'unmeasured');
  });

  it('fails survivors, no-coverage, runtime errors and pending mutants', () => {
    const result = evaluateMutationGate(
      [reported('src/a.ts', ['Killed', 'Survived', 'NoCoverage', 'RuntimeError', 'Pending', 'NoCoverage'])],
      [],
      [],
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.files[0]?.problems, [
      'Survived NumericLiteral at 2:17 -> "0"',
      '2 NoCoverage mutant(s); expected none',
      '1 RuntimeError mutant(s); expected none',
      '1 Pending mutant(s); expected none',
    ]);
    assert.equal(result.files[0].verdict, 'failed');
  });

  it('shows an empty replacement for a survivor without one', () => {
    const file: ReportedFile = {
      path: 'src/a.ts',
      source: RUNTIME_SOURCE,
      mutants: [{ id: '1', mutatorName: 'BlockStatement', status: 'Survived', line: 4, column: 2 }],
    };
    assert.deepEqual(evaluateMutationGate([file], [], []).files[0]?.problems, ['Survived BlockStatement at 4:2 -> ""']);
  });

  it('accepts a survivor only under an approved equivalence that matches it exactly', () => {
    const survivors = reported('src/a.ts', ['Killed', 'Survived']);
    const accepted = evaluateMutationGate([survivors], [approved], runtimeTargets('src/a.ts'));
    assert.equal(accepted.passed, true);
    assert.equal(accepted.files[0]?.accepted_equivalent, 1);
    const mismatches: readonly Partial<Equivalence>[] = [
      { file: 'src/b.ts' },
      { mutator: 'StringLiteral' },
      { line: 3 },
      { column: 1 },
      { replacement: '1' },
    ];
    for (const change of mismatches) {
      const result = evaluateMutationGate([survivors], [{ ...approved, ...change }], []);
      assert.equal(result.files[0]?.verdict, 'failed', JSON.stringify(change));
    }
    const withoutReplacement: ReportedFile = {
      ...survivors,
      mutants: [{ id: 'x', mutatorName: 'NumericLiteral', status: 'Survived', line: 2, column: 17 }],
    };
    assert.equal(
      evaluateMutationGate([withoutReplacement], [{ ...approved, replacement: '' }], []).files[0]?.verdict,
      'passed',
    );
  });

  it('treats an equivalence without a human decision as pending and failing', () => {
    for (const unapproved of [{ approved_by: '' }, { approved_at: '' }]) {
      const result = evaluateMutationGate(
        [reported('src/a.ts', ['Killed', 'Survived'])],
        [{ ...approved, ...unapproved }],
        [],
      );
      assert.equal(result.passed, false);
      assert.equal(result.files[0]?.verdict, 'failed');
      assert.deepEqual(result.problems, [
        'pending equivalence src/a.ts:2:17 NumericLiteral; expected an authorized human decision (approved_by, approved_at)',
      ]);
    }
    const { approved_at: _onlyAt, ...unsigned } = approved;
    const unsignedResult = evaluateMutationGate([reported('src/a.ts', ['Killed', 'Survived'])], [unsigned], []);
    assert.equal(unsignedResult.files[0]?.verdict, 'failed');
    assert.equal(unsignedResult.problems.length, 1);
    const { approved_by: _by, approved_at: _at, ...undecided } = approved;
    assert.equal(
      evaluateMutationGate([reported('src/a.ts', ['Killed', 'Survived'])], [undecided], []).files[0]?.verdict,
      'failed',
    );
    const pending = evaluateMutationGate([reported('src/a.ts', ['Killed'])], [undecided], []);
    assert.equal(pending.passed, false);
    assert.equal(pending.files[0]?.verdict, 'passed');
    assert.equal(pending.problems.length, 1);
  });

  it('marks zero valid mutants as unmeasured unless the module is type-only', () => {
    const unmeasured = evaluateMutationGate([reported('src/a.ts', ['CompileError'])], [], []);
    assert.equal(unmeasured.passed, false);
    assert.equal(unmeasured.files[0]?.verdict, 'unmeasured');
    assert.deepEqual(unmeasured.files[0].problems, [
      'zero valid mutants in a file with runtime code; zero valid sites is unmeasured',
    ]);
    const typeOnly = evaluateMutationGate(
      [reported('src/t.ts', [], 'export interface T { readonly a: 1 }')],
      [],
      runtimeTargets('src/t.ts'),
    );
    assert.equal(typeOnly.passed, true);
    assert.equal(typeOnly.files[0]?.verdict, 'type_only');
    assert.deepEqual(typeOnly.files[0].problems, []);
  });

  it('fails an expected target that the report lacks, and an empty report', () => {
    const result = evaluateMutationGate([reported('src/a.ts', ['Killed'])], [], runtimeTargets('src/a.ts', 'src/b.ts'));
    assert.equal(result.passed, false);
    assert.deepEqual(result.files[1], {
      path: 'src/b.ts',
      verdict: 'missing',
      counts: {
        Killed: 0,
        Survived: 0,
        NoCoverage: 0,
        CompileError: 0,
        RuntimeError: 0,
        Timeout: 0,
        Ignored: 0,
        Pending: 0,
      },
      valid: 0,
      accepted_equivalent: 0,
      problems: ['expected target file with runtime code is absent from the report; it was not mutated'],
      timeouts: [],
    });
    assert.deepEqual(evaluateMutationGate([], [], []), {
      passed: false,
      files: [],
      problems: ['the report holds no target file; zero files is not verification'],
    });
  });

  // WP-00 review round 2: Stryker never lists a file without mutants, so an absent type-only
  // target was judged missing while a listed one was type_only, and the gate could not pass.
  it('judges an absent type-only target exactly as a listed one: type_only, not missing', () => {
    const typeOnlySource =
      "import type { A } from './a.ts';\nexport interface T { readonly a: A }\nexport type U = T;\n";
    const absent = evaluateMutationGate(
      [reported('src/a.ts', ['Killed'])],
      [],
      [...runtimeTargets('src/a.ts'), { path: 'src/t.ts', source: typeOnlySource }],
    );
    const listed = evaluateMutationGate(
      [reported('src/a.ts', ['Killed']), reported('src/t.ts', [], typeOnlySource)],
      [],
      [],
    );
    assert.equal(absent.passed, true);
    assert.deepEqual(absent.files[1], listed.files[1]);
    assert.equal(absent.files[1]?.verdict, 'type_only');
    // A value export or a side-effect import is runtime code, so its absence is still missing.
    for (const source of [
      'export const a = 1;\n',
      "import './a.ts';\nexport type T = 1;\n",
      "import { type A } from './a.ts';\n",
    ]) {
      const result = evaluateMutationGate([reported('src/a.ts', ['Killed'])], [], [{ path: 'src/r.ts', source }]);
      assert.equal(result.passed, false, source);
      assert.equal(result.files[1]?.verdict, 'missing', source);
    }
  });
});
