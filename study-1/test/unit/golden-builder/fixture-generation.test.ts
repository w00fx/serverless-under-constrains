// The golden fixture generator over its in-memory port emulators (design §12.4): cases are
// discovered, loaded, parsed, materialized and bundled; `--check` reports a missing or differing
// fixture file, every missing, extra or differing file inside it, every orphan entry under
// fixtures/ and every broken case; writing creates only missing fixtures, and replacing a
// committed one needs `--overwrite <case-id>` (truth layer).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeFixtureBundle } from '../../../tools/golden/lib/fixture-bundle.ts';
import {
  compareFixture,
  generateFixtures,
  orphanFixtures,
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
import type { GeneratedFixture } from '../../../tools/golden/lib/fixture-generation.ts';

const CASE_A = 'test/golden/f/cases/case-a.case.ts';
const CASE_B = 'test/golden/f/cases/case-b.case.ts';
const FIXTURE_A = 'test/golden/f/fixtures/case-a.fixture.json';
const RUNNER = 'runner/runner-journal.jsonl';
const PAYMENT = 'probe/inputs/payment.json';
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

function committedA(files: ReadonlyMap<string, Uint8Array> = aBytes): ReadonlyMap<string, Uint8Array> {
  return new Map([[FIXTURE_A, encodeFixtureBundle(files)]]);
}

// The files of case-a with one changed byte in `path`.
function withChangedByte(path: string): ReadonlyMap<string, Uint8Array> {
  const changed = Uint8Array.from(aBytes.get(path) ?? []);
  changed[changed.length - 1] = 0x20;
  return new Map([...aBytes, [path, changed]]);
}

describe('fixture layout', () => {
  it('maps a case file to its id and sibling fixture file', () => {
    assert.deepEqual(locateCase(CASE_A), { case_id: 'case-a', fixture_file: FIXTURE_A });
    assert.deepEqual(locateCase('cases/x.case.ts'), { case_id: 'x', fixture_file: 'fixtures/x.fixture.json' });
    assert.deepEqual(locateCase('test\\golden\\f\\cases\\y.case.ts'), {
      case_id: 'y',
      fixture_file: 'test/golden/f/fixtures/y.fixture.json',
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
      report.fixtures.map((fixture) => [fixture.case_id, fixture.fixture_file]),
      [['case-a', FIXTURE_A]],
    );
    assert.ok(
      sameBytes(report.fixtures[0]?.files.get(RUNNER) ?? new Uint8Array(), aBytes.get(RUNNER) ?? Uint8Array.of(0)),
    );
    assert.deepEqual(report.fixtures[0]?.bundle, encodeFixtureBundle(aBytes));
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
  async function caseA(committed: ReadonlyMap<string, Uint8Array>): Promise<{
    readonly files: MemoryFixtureFileSystem;
    readonly fixture: GeneratedFixture;
    readonly fixtures: readonly GeneratedFixture[];
  }> {
    const { files, loader } = setup(new Map([[CASE_A, probeCase('case-a')]]), committed);
    const { fixtures } = await generateFixtures(files.findCaseFiles(), loader);
    const [fixture] = fixtures;
    assert.ok(fixture !== undefined);
    return { files, fixture, fixtures };
  }

  it('finds nothing when the committed bytes are the regeneration', async () => {
    const { files, fixture, fixtures } = await caseA(committedA());
    assert.deepEqual(compareFixture(files, fixture), []);
    assert.deepEqual(orphanFixtures(files, fixtures), []);
  });

  it('reports a missing, an extra and a differing file inside the fixture, and an orphan fixture', async () => {
    const edited = new Map(withChangedByte(PAYMENT));
    edited.delete(RUNNER);
    edited.set('extra.json', encoder.encode('{}\n'));
    const committed = new Map([
      ...committedA(edited),
      ['test/golden/f/fixtures/deleted-case.fixture.json', encoder.encode('{}\n')],
    ]);
    const { files, fixture, fixtures } = await caseA(committed);
    assert.deepEqual(compareFixture(files, fixture), [
      { kind: 'different', path: `${FIXTURE_A}#${PAYMENT}` },
      { kind: 'missing', path: `${FIXTURE_A}#${RUNNER}` },
      { kind: 'extra', path: `${FIXTURE_A}#extra.json` },
    ]);
    assert.deepEqual(orphanFixtures(files, fixtures), ['test/golden/f/fixtures/deleted-case.fixture.json']);
  });

  it('names a file whose changed bytes are no longer UTF-8 text', async () => {
    const edited = new Map([...aBytes, [PAYMENT, Uint8Array.of(0xff, 0x0a)]]);
    const { files, fixture } = await caseA(committedA(edited));
    assert.deepEqual(compareFixture(files, fixture), [{ kind: 'different', path: `${FIXTURE_A}#${PAYMENT}` }]);
  });

  it('reports the fixture file itself when it is missing, does not decode, or holds the same files in other bytes', async () => {
    const absent = await caseA(new Map());
    assert.deepEqual(compareFixture(absent.files, absent.fixture), [{ kind: 'missing', path: FIXTURE_A }]);
    for (const bytes of [
      encoder.encode('not json\n'),
      encoder.encode(`${JSON.stringify(JSON.parse(new TextDecoder().decode(encodeFixtureBundle(aBytes))))}\n`),
    ]) {
      const { files, fixture } = await caseA(new Map([[FIXTURE_A, bytes]]));
      assert.deepEqual(compareFixture(files, fixture), [{ kind: 'different', path: FIXTURE_A }]);
    }
  });

  // Regression (M1 checkpoint, decision 52): a fixture in a golden directory with no cases/ at all
  // is an orphan too, so no committed fixture escapes the reproducibility check.
  it('reports a fixture of a golden directory without cases as an orphan', async () => {
    const committed = new Map([
      ...committedA(),
      ['test/golden/hand/fixtures/tree.fixture.json', encoder.encode('{}\n')],
    ]);
    const { files, fixtures } = await caseA(committed);
    assert.deepEqual(orphanFixtures(files, fixtures), ['test/golden/hand/fixtures/tree.fixture.json']);
  });

  it('reports a stale fixture beside a root-level cases/ directory as an orphan', async () => {
    const { files, loader } = setup(
      new Map([['test/golden/cases/root.case.ts', probeCase('root')]]),
      new Map([['test/golden/fixtures/stale.fixture.json', encoder.encode('{}\n')]]),
    );
    const report = await generateFixtures(files.findCaseFiles(), loader);
    assert.deepEqual(orphanFixtures(files, report.fixtures), ['test/golden/fixtures/stale.fixture.json']);
  });

  it('reports the fixture of a case that fails to load as an orphan', async () => {
    const { files, loader } = setup(
      new Map<string, StaticCaseModule>([[CASE_B, { kind: 'throws', message: 'syntax' }]]),
      new Map([['test/golden/f/fixtures/case-b.fixture.json', encoder.encode('{}\n')]]),
    );
    const report = await generateFixtures(files.findCaseFiles(), loader);
    assert.deepEqual(report.fixtures, []);
    assert.deepEqual(orphanFixtures(files, report.fixtures), ['test/golden/f/fixtures/case-b.fixture.json']);
  });

  // A fixture directory in the layout before one file per case holds files no check reads, so it
  // is an orphan even beside its case's fixture file.
  it('reports a fixture directory as an orphan, even one named after a case', async () => {
    const committed = new Map([
      ...committedA(),
      [`test/golden/f/fixtures/case-a/${RUNNER}`, aBytes.get(RUNNER) ?? new Uint8Array()],
    ]);
    const { files, fixture, fixtures } = await caseA(committed);
    assert.deepEqual(compareFixture(files, fixture), []);
    assert.deepEqual(orphanFixtures(files, fixtures), ['test/golden/f/fixtures/case-a']);
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
    assert.deepEqual(files.readFile(FIXTURE_A), encodeFixtureBundle(aBytes));
    assert.equal(writeFixture(files, fixture, false), 'unchanged');
    const tampered = encodeFixtureBundle(withChangedByte(RUNNER));
    files.writeFile(FIXTURE_A, tampered);
    assert.equal(writeFixture(files, fixture, false), 'refused');
    assert.deepEqual(files.readFile(FIXTURE_A), tampered, 'a refused write changes nothing');
    assert.equal(writeFixture(files, fixture, true), 'overwritten');
    assert.deepEqual(compareFixture(files, fixture), []);
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
    dirty.files.writeFile('test/golden/f/fixtures/orphan.fixture.json', encoder.encode('{}\n'));
    assert.deepEqual(await runFixtureCommand(['--check'], dirty), {
      stdout: 'golden fixtures (check): 1 case(s), 2 problem(s)\n',
      stderr:
        `${FIXTURE_A}: missing; expected the regenerated fixture bytes\n` +
        'test/golden/f/fixtures/orphan.fixture.json: no case owns this fixture entry; ' +
        'expected fixtures/<case-id>.fixture.json beside cases/<case-id>.case.ts\n',
      exit_code: 1,
    });
    assert.equal(dirty.files.readFile(FIXTURE_A), undefined, 'check never writes');
    const changed = setup(new Map([[CASE_A, probeCase('case-a')]]), committedA(withChangedByte(PAYMENT)));
    assert.deepEqual(await runFixtureCommand(['--check'], changed), {
      stdout: 'golden fixtures (check): 1 case(s), 1 problem(s)\n',
      stderr: `${FIXTURE_A}#${PAYMENT}: different; expected the regenerated fixture bytes\n`,
      exit_code: 1,
    });
  });

  // Regression (decision 52): a fixture with no cases/ beside it fails the check instead of being
  // listed and skipped, so a hand-written fixture cannot bypass reproducibility.
  it('fails the check on a fixture of a golden directory without cases', async () => {
    const ports = setup(
      new Map([[CASE_A, probeCase('case-a')]]),
      new Map([...committedA(), ['test/golden/hand/fixtures/tree.fixture.json', encoder.encode('{}\n')]]),
    );
    assert.deepEqual(await runFixtureCommand(['--check'], ports), {
      stdout: 'golden fixtures (check): 1 case(s), 1 problem(s)\n',
      stderr:
        'test/golden/hand/fixtures/tree.fixture.json: no case owns this fixture entry; ' +
        'expected fixtures/<case-id>.fixture.json beside cases/<case-id>.case.ts\n',
      exit_code: 1,
    });
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
    ports.files.writeFile(FIXTURE_A, encodeFixtureBundle(withChangedByte(RUNNER)));
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
