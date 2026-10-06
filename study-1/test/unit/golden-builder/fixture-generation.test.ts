// The golden fixture generator over its in-memory port emulators (design §12.4): cases are
// discovered, loaded, parsed and materialized; `--check` reports every missing, extra or
// differing file, every orphan fixture directory and every broken case; writing creates only
// missing fixtures, and replacing a committed one needs `--overwrite <case-id>` (truth layer).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareFixture,
  generateFixtures,
  handAuthoredFixtureDirectories,
  orphanFixtureDirectories,
  sameBytes,
  writeFixture,
} from '../../../tools/golden/lib/fixture-generation.ts';
import { parseFixtureArguments, runFixtureCommand } from '../../../tools/golden/lib/fixture-command.ts';
import { locateCase } from '../../support/golden-builder/fixture-layout.ts';
import { materializeCase } from '../../support/golden-builder/fixture-materializer.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import { MemoryFixtureFileSystem } from '../../support/golden-builder/memory-fixture-file-system.ts';
import { StaticCaseModuleLoader } from '../../support/golden-builder/static-case-module-loader.ts';
import type { StaticCaseModule } from '../../support/golden-builder/static-case-module-loader.ts';

const CASE_A = 'test/golden/f/cases/case-a.case.ts';
const CASE_B = 'test/golden/f/cases/case-b.case.ts';
const FIXTURE_A = 'test/golden/f/fixtures/case-a';
const RUNNER = 'runner/runner-journal.jsonl';
const encoder = new TextEncoder();

const probeCase = (caseId: string): StaticCaseModule => ({
  kind: 'default_export',
  value: defineGoldenCase({ case_id: caseId, ac_ids: [], rule_outcomes_reached: [], base: 'probe', expected: null }),
});

const aBytes = ((): ReadonlyMap<string, Uint8Array> => {
  const materialized = materializeCase(
    defineGoldenCase({ case_id: 'case-a', ac_ids: [], rule_outcomes_reached: [], base: 'probe', expected: null }),
  );
  assert.ok(materialized.ok);
  return materialized.value;
})();

function setup(
  modules: ReadonlyMap<string, StaticCaseModule>,
  committed: ReadonlyMap<string, Uint8Array> = new Map(),
): {
  readonly files: MemoryFixtureFileSystem;
  readonly loader: StaticCaseModuleLoader;
} {
  const files = new MemoryFixtureFileSystem(
    new Map([
      ...[...modules.keys()].map((path): [string, Uint8Array] => [path, encoder.encode('export default {};\n')]),
      ...committed,
    ]),
  );
  return { files, loader: new StaticCaseModuleLoader(modules) };
}

function committedA(): ReadonlyMap<string, Uint8Array> {
  return new Map([...aBytes].map(([path, bytes]) => [`${FIXTURE_A}/${path}`, bytes]));
}

describe('fixture layout', () => {
  it('maps a case file to its id and sibling fixture directory', () => {
    assert.deepEqual(locateCase(CASE_A), { case_id: 'case-a', fixture_directory: FIXTURE_A });
    assert.deepEqual(locateCase('cases/x.case.ts'), { case_id: 'x', fixture_directory: 'fixtures/x' });
    assert.deepEqual(locateCase('test\\golden\\f\\cases\\y.case.ts'), {
      case_id: 'y',
      fixture_directory: 'test/golden/f/fixtures/y',
    });
  });

  it('rejects paths that are not case files', () => {
    for (const path of [
      'test/golden/f/cases/x.ts',
      'test/golden/f/case/x.case.ts',
      'test/golden/f/cases/sub/x.case.ts',
      'test/golden/f/mycases/x.case.ts',
      'x.case.ts',
    ]) {
      assert.equal(locateCase(path), undefined, path);
    }
  });
});

describe('generateFixtures', () => {
  it('materializes every loadable case and reports the others', async () => {
    const modules = new Map<string, StaticCaseModule>([
      [CASE_A, probeCase('case-a')],
      [CASE_B, probeCase('wrong-id')],
      ['test/golden/f/cases/throws.case.ts', { kind: 'throws', message: 'boom' }],
      ['test/golden/f/cases/no-default.case.ts', { kind: 'no_default_export' }],
      ['test/golden/f/cases/bad.case.ts', { kind: 'default_export', value: { case_id: 'bad' } }],
      [
        'test/golden/f/cases/bad-plan.case.ts',
        {
          kind: 'default_export',
          value: {
            ...defineGoldenCase({
              case_id: 'bad-plan',
              ac_ids: [],
              rule_outcomes_reached: [],
              base: 'probe',
              expected: null,
            }),
            plan: { deliveries: [], processing: 'completes' },
          },
        },
      ],
    ]);
    const { files, loader } = setup(modules);
    const report = await generateFixtures([...files.findCaseFiles(), 'test/golden/f/not-a-case.ts'], loader);
    assert.deepEqual(
      report.fixtures.map((fixture) => [fixture.case_id, fixture.fixture_directory]),
      [['case-a', FIXTURE_A]],
    );
    assert.ok(
      sameBytes(report.fixtures[0]?.files.get(RUNNER) ?? new Uint8Array(), aBytes.get(RUNNER) ?? Uint8Array.of(0)),
    );
    assert.deepEqual(
      report.problems.map((problem) => problem.split(': ')[0]),
      [
        'test/golden/f/cases/bad-plan.case.ts',
        'test/golden/f/cases/bad.case.ts',
        'test/golden/f/cases/bad.case.ts',
        'test/golden/f/cases/bad.case.ts',
        'test/golden/f/cases/bad.case.ts',
        'test/golden/f/cases/bad.case.ts',
        'test/golden/f/cases/case-b.case.ts',
        'test/golden/f/cases/no-default.case.ts',
        'test/golden/f/cases/throws.case.ts',
        'test/golden/f/not-a-case.ts',
      ],
    );
    assert.ok(
      report.problems.includes(
        'test/golden/f/cases/case-b.case.ts: case_id "wrong-id"; expected the file name\'s "case-b"',
      ),
    );
    assert.ok(
      report.problems.includes(
        'test/golden/f/cases/bad-plan.case.ts: case.plan: the probe plan has 0 invocations; expected exactly 1 (BR-RUA-027)',
      ),
    );
    assert.ok(
      report.problems.includes(
        'test/golden/f/not-a-case.ts: the path is not <dir>/cases/<case-id>.case.ts; expected a case file',
      ),
    );
    assert.match(report.problems.find((problem) => problem.startsWith('test/golden/f/cases/throws')) ?? '', /boom/);
  });
});

describe('compareFixture and orphans', () => {
  it('finds nothing when the committed bytes are the regeneration', async () => {
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]), committedA());
    const report = await generateFixtures(files.findCaseFiles(), loader);
    const [fixture] = report.fixtures;
    assert.ok(fixture !== undefined);
    assert.deepEqual(compareFixture(files, fixture), []);
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), []);
  });

  it('reports a missing, an extra and a differing file, and an orphan directory', async () => {
    const committed = new Map(committedA());
    committed.delete(`${FIXTURE_A}/${RUNNER}`);
    committed.set(`${FIXTURE_A}/extra.json`, encoder.encode('{}\n'));
    const payment = `${FIXTURE_A}/probe/inputs/payment.json`;
    const changed = Uint8Array.from(committed.get(payment) ?? []);
    changed[changed.length - 1] = 0x20;
    committed.set(payment, changed);
    committed.set('test/golden/f/fixtures/deleted-case/a.json', encoder.encode('{}\n'));
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]), committed);
    const report = await generateFixtures(files.findCaseFiles(), loader);
    const [fixture] = report.fixtures;
    assert.ok(fixture !== undefined);
    assert.deepEqual(compareFixture(files, fixture), [
      { kind: 'different', path: payment },
      { kind: 'missing', path: `${FIXTURE_A}/${RUNNER}` },
      { kind: 'extra', path: `${FIXTURE_A}/extra.json` },
    ]);
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), ['test/golden/f/fixtures/deleted-case']);
    assert.deepEqual(handAuthoredFixtureDirectories(files), []);
  });

  // Regression (M1 staging tip fc334f2): the WP-13 evidence-index tree
  // `test/golden/evidence-package/fixtures/durable-run-trial` has no case beside it and failed
  // `npm run test:golden` as an orphan.
  it('leaves fixtures of a golden directory without cases to their author and lists them', async () => {
    const committed = new Map(committedA());
    committed.set('test/golden/f/fixtures/deleted-case/a.json', encoder.encode('{}\n'));
    committed.set('test/golden/hand/fixtures/tree/package/a.json', encoder.encode('{}\n'));
    committed.set('test/golden/fixtures/top/a.json', encoder.encode('{}\n'));
    committed.set('test/golden/f/sub/fixtures/nested/a.json', encoder.encode('{}\n'));
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]), committed);
    const report = await generateFixtures(files.findCaseFiles(), loader);
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), ['test/golden/f/fixtures/deleted-case']);
    assert.deepEqual(handAuthoredFixtureDirectories(files), [
      'test/golden/f/sub/fixtures/nested',
      'test/golden/fixtures/top',
      'test/golden/hand/fixtures/tree',
    ]);
  });

  it('counts a golden directory as managed when its only case fails to load', async () => {
    const { files, loader } = setup(
      new Map<string, StaticCaseModule>([[CASE_B, { kind: 'throws', message: 'syntax' }]]),
      new Map([['test/golden/f/fixtures/case-b/a.json', encoder.encode('{}\n')]]),
    );
    const report = await generateFixtures(files.findCaseFiles(), loader);
    assert.deepEqual(report.fixtures, []);
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), ['test/golden/f/fixtures/case-b']);
    assert.deepEqual(handAuthoredFixtureDirectories(files), []);
  });

  it('manages a root-level cases/ directory and its fixtures', async () => {
    const { files, loader } = setup(
      new Map([['test/golden/cases/root.case.ts', probeCase('root')]]),
      new Map([['test/golden/fixtures/stale/a.json', encoder.encode('{}\n')]]),
    );
    const report = await generateFixtures(files.findCaseFiles(), loader);
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), ['test/golden/fixtures/stale']);
    assert.deepEqual(handAuthoredFixtureDirectories(files), []);
  });

  it('compares bytes exactly', () => {
    assert.equal(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
    assert.equal(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
    assert.equal(sameBytes(Uint8Array.of(1), Uint8Array.of(1, 0)), false);
    assert.equal(sameBytes(new Uint8Array(), new Uint8Array()), true);
  });
});

describe('writeFixture', () => {
  it('writes a new fixture, leaves an equal one, refuses a differing one unless overwriting', async () => {
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]));
    const [fixture] = (await generateFixtures(files.findCaseFiles(), loader)).fixtures;
    assert.ok(fixture !== undefined);
    assert.equal(writeFixture(files, fixture, false), 'written');
    assert.deepEqual(compareFixture(files, fixture), []);
    assert.equal(writeFixture(files, fixture, false), 'unchanged');
    files.writeFile(`${FIXTURE_A}/stale.json`, encoder.encode('{}\n'));
    files.writeFile(`${FIXTURE_A}/${RUNNER}`, encoder.encode('tampered\n'));
    assert.equal(writeFixture(files, fixture, false), 'refused');
    assert.deepEqual(
      files.readFile(`${FIXTURE_A}/${RUNNER}`),
      encoder.encode('tampered\n'),
      'a refused write changes nothing',
    );
    assert.equal(writeFixture(files, fixture, true), 'overwritten');
    assert.deepEqual(compareFixture(files, fixture), []);
    assert.equal(files.readFile(`${FIXTURE_A}/stale.json`), undefined);
  });
});

describe('fixture command', () => {
  it('parses check, repeated overwrites and the root, and rejects the rest', () => {
    assert.deepEqual(parseFixtureArguments([]), { ok: true, value: { check: false, overwrite: new Set() } });
    assert.deepEqual(parseFixtureArguments(['--check', '--root', '/x']), {
      ok: true,
      value: { check: true, overwrite: new Set() },
    });
    assert.deepEqual(parseFixtureArguments(['--overwrite', 'a', '--overwrite', 'b']), {
      ok: true,
      value: { check: false, overwrite: new Set(['a', 'b']) },
    });
    for (const args of [['--overwrite'], ['--overwrite', '--check'], ['--root'], ['--force'], ['case-a']]) {
      const parsed = parseFixtureArguments(args);
      assert.ok(!parsed.ok, JSON.stringify(args));
      assert.match(parsed.error, /; usage: node tools\/golden\/generate-fixtures\.ts/);
    }
    assert.deepEqual(parseFixtureArguments(['--check', '--overwrite', 'a']), {
      ok: false,
      error:
        '--check with --overwrite a; expected one mode. usage: node tools/golden/generate-fixtures.ts [--check] [--overwrite <case-id>]... [--root <dir>]',
    });
  });

  it('exits 2 on a usage error without touching anything', async () => {
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]));
    const outcome = await runFixtureCommand(['--bogus'], { files, loader });
    assert.equal(outcome.exit_code, 2);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /^argument "--bogus"/);
    assert.deepEqual(loader.loadedPaths(), []);
  });

  it('checks: 0 when every fixture reproduces, 1 with each discrepancy otherwise', async () => {
    const clean = setup(new Map([[CASE_A, probeCase('case-a')]]), committedA());
    assert.deepEqual(await runFixtureCommand(['--check'], clean), {
      stdout: 'golden fixtures (check): 1 case(s), 0 problem(s)\n',
      stderr: '',
      exit_code: 0,
    });
    const dirty = setup(new Map([[CASE_A, probeCase('case-a')]]));
    dirty.files.writeFile('test/golden/f/fixtures/orphan/a.json', encoder.encode('{}\n'));
    const outcome = await runFixtureCommand(['--check'], dirty);
    assert.equal(outcome.exit_code, 1);
    assert.equal(outcome.stdout, `golden fixtures (check): 1 case(s), ${String(aBytes.size + 1)} problem(s)\n`);
    assert.match(
      outcome.stderr,
      /^test\/golden\/f\/fixtures\/case-a\/admission\/execution-manifest\.json: missing; expected the regenerated fixture bytes$/m,
    );
    assert.match(outcome.stderr, /^test\/golden\/f\/fixtures\/orphan: no case owns this fixture directory/m);
    assert.equal(dirty.files.listFiles(FIXTURE_A).length, 0, 'check never writes');
  });

  it('lists a hand-authored fixture in either mode without counting it as a problem', async () => {
    const handMade = new Map([['test/golden/hand/fixtures/tree/a.json', encoder.encode('{}\n')]]);
    const listed =
      'test/golden/hand/fixtures/tree: hand-authored fixture, neither generated nor checked (no cases/ beside it)\n';
    const checked = setup(new Map([[CASE_A, probeCase('case-a')]]), new Map([...committedA(), ...handMade]));
    assert.deepEqual(await runFixtureCommand(['--check'], checked), {
      stdout: `${listed}golden fixtures (check): 1 case(s), 0 problem(s)\n`,
      stderr: '',
      exit_code: 0,
    });
    const written = setup(new Map([[CASE_A, probeCase('case-a')]]), handMade);
    assert.deepEqual(await runFixtureCommand([], written), {
      stdout: `case-a: written\n${listed}golden fixtures (write): 1 case(s), 0 problem(s)\n`,
      stderr: '',
      exit_code: 0,
    });
    assert.deepEqual(written.files.listFiles('test/golden/hand/fixtures/tree'), ['a.json'], 'never written');
  });

  it('writes missing fixtures, refuses changed ones, and overwrites only named cases', async () => {
    const ports = setup(new Map([[CASE_A, probeCase('case-a')]]));
    assert.deepEqual(await runFixtureCommand([], ports), {
      stdout: 'case-a: written\ngolden fixtures (write): 1 case(s), 0 problem(s)\n',
      stderr: '',
      exit_code: 0,
    });
    assert.equal(
      (await runFixtureCommand([], ports)).stdout,
      'case-a: unchanged\ngolden fixtures (write): 1 case(s), 0 problem(s)\n',
    );
    ports.files.writeFile(`${FIXTURE_A}/${RUNNER}`, encoder.encode('tampered\n'));
    const refused = await runFixtureCommand([], ports);
    assert.equal(refused.exit_code, 1);
    assert.equal(
      refused.stderr,
      `${FIXTURE_A}: committed fixture differs from its case; expected an unchanged fixture or --overwrite case-a\n`,
    );
    const unknown = await runFixtureCommand(['--overwrite', 'case-z'], ports);
    assert.equal(unknown.exit_code, 1);
    assert.match(unknown.stderr, /^--overwrite case-z: no case has that id; expected an existing case id$/m);
    const overwritten = await runFixtureCommand(['--overwrite', 'case-a'], ports);
    assert.deepEqual(overwritten, {
      stdout: 'case-a: overwritten\ngolden fixtures (write): 1 case(s), 0 problem(s)\n',
      stderr: '',
      exit_code: 0,
    });
  });

  it('reports a broken case and still processes the others', async () => {
    const ports = setup(
      new Map<string, StaticCaseModule>([
        [CASE_A, probeCase('case-a')],
        [CASE_B, { kind: 'throws', message: 'syntax' }],
      ]),
      committedA(),
    );
    const outcome = await runFixtureCommand(['--check'], ports);
    assert.equal(outcome.exit_code, 1);
    assert.equal(outcome.stdout, 'golden fixtures (check): 1 case(s), 1 problem(s)\n');
    assert.match(
      outcome.stderr,
      /^test\/golden\/f\/cases\/case-b\.case\.ts: test\/golden\/f\/cases\/case-b\.case\.ts failed to load \(Error: syntax\)/,
    );
  });
});
