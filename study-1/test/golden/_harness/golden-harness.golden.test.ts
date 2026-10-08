// `loadGoldenCase` against a real study tree in a temporary directory: it loads a case module and
// its committed fixture bytes, and fails the calling test with the reason when the path is not a
// case file, the module does not load, the case does not parse, or the fixture is absent, empty or
// does not decode.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadGoldenCase } from './golden-harness.ts';

const root = mkdtempSync(join(tmpdir(), 'rua-golden-harness-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const CASE = { case_id: 'x', ac_ids: [], rule_outcomes_reached: [], base: 'probe', operations: [], expected: { a: 1 } };

describe('loadGoldenCase', () => {
  it('loads the case and its committed fixture bytes', async () => {
    put('test/golden/h/cases/x.case.ts', `export default ${JSON.stringify(CASE)};\n`);
    put(
      'test/golden/h/fixtures/x.fixture.json',
      JSON.stringify({ 'probe/a.json': ['{"a":1}', ''], 'runner/runner-journal.jsonl': ['{"b":2}', ''] }),
    );
    const loaded = await loadGoldenCase('test/golden/h/cases/x.case.ts', root);
    assert.deepEqual(loaded.golden_case, CASE);
    assert.equal(loaded.fixture_file, 'test/golden/h/fixtures/x.fixture.json');
    assert.equal(loaded.subject_directory, 'probe');
    assert.deepEqual([...loaded.files.keys()], ['probe/a.json', 'runner/runner-journal.jsonl']);
    assert.equal(new TextDecoder().decode(loaded.files.get('probe/a.json')), '{"a":1}\n');
  });

  it('fails for a path that is not a case file', async () => {
    await assert.rejects(
      loadGoldenCase('test/golden/h/x.ts', root),
      /test\/golden\/h\/x\.ts is not <dir>\/cases\/<case-id>\.case\.ts/,
    );
  });

  it('fails for a module that does not load or a case that does not parse', async () => {
    put('test/golden/h/cases/throws.case.ts', 'throw new Error("broken case");\n');
    await assert.rejects(
      loadGoldenCase('test/golden/h/cases/throws.case.ts', root),
      /failed to load \(Error: broken case\)/,
    );
    put(
      'test/golden/h/cases/open.case.ts',
      `export default ${JSON.stringify({ ...CASE, case_id: 'open', extra: 1 })};\n`,
    );
    await assert.rejects(
      loadGoldenCase('test/golden/h/cases/open.case.ts', root),
      /does not parse:\ncase has unknown member "extra"/,
    );
  });

  it('fails when the case has no committed fixture', async () => {
    put('test/golden/h/cases/bare.case.ts', `export default ${JSON.stringify({ ...CASE, case_id: 'bare' })};\n`);
    await assert.rejects(
      loadGoldenCase('test/golden/h/cases/bare.case.ts', root),
      /^Error: test\/golden\/h\/fixtures\/bare\.fixture\.json is absent; expected the committed fixture of test\/golden\/h\/cases\/bare\.case\.ts$/,
    );
  });

  it('fails when the committed fixture holds no files or does not decode', async () => {
    put('test/golden/h/cases/empty.case.ts', `export default ${JSON.stringify({ ...CASE, case_id: 'empty' })};\n`);
    put('test/golden/h/fixtures/empty.fixture.json', '{}\n');
    await assert.rejects(
      loadGoldenCase('test/golden/h/cases/empty.case.ts', root),
      /^Error: test\/golden\/h\/fixtures\/empty\.fixture\.json holds no files; expected the committed fixture of test\/golden\/h\/cases\/empty\.case\.ts$/,
    );
    put('test/golden/h/cases/broken.case.ts', `export default ${JSON.stringify({ ...CASE, case_id: 'broken' })};\n`);
    put('test/golden/h/fixtures/broken.fixture.json', '{"probe/a.json":"{}"}\n');
    await assert.rejects(
      loadGoldenCase('test/golden/h/cases/broken.case.ts', root),
      /^Error: test\/golden\/h\/fixtures\/broken\.fixture\.json: member probe\/a\.json is "\{\}"; expected a non-empty array of lines without a newline, or \{"base64": <canonical base64>\}$/,
    );
  });
});
