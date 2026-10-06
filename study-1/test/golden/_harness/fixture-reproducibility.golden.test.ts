// Every committed golden fixture follows byte for byte from its case file (design §12.4): the
// cases under `test/golden/` are discovered by glob, regenerated in memory and compared with the
// committed bytes, one test per case, and no fixture directory exists without its case. This is
// the in-suite twin of `generate-fixtures.ts --check`, so a failing case is named in the report.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeCaseModuleLoader } from '../../../tools/golden/lib/case-module-loader.ts';
import { NodeFixtureFileSystem } from '../../../tools/golden/lib/fixture-file-system.ts';
import {
  compareFixture,
  generateFixtures,
  orphanFixtureDirectories,
} from '../../../tools/golden/lib/fixture-generation.ts';
import { STUDY_ROOT } from './golden-harness.ts';

const files = new NodeFixtureFileSystem(STUDY_ROOT);
const caseFiles = files.findCaseFiles();
const report = await generateFixtures(caseFiles, new NodeCaseModuleLoader(STUDY_ROOT));

describe('golden fixtures reproduce from their cases', () => {
  it('finds the harness base cases and regenerates every case without a problem', () => {
    assert.ok(caseFiles.length >= 9, `found ${String(caseFiles.length)} case file(s); expected at least the 9 bases`);
    assert.deepEqual(report.problems, []);
    assert.equal(report.fixtures.length, caseFiles.length);
  });

  for (const fixture of report.fixtures) {
    it(`${fixture.case_id}: the committed fixture equals its regeneration byte for byte`, () => {
      assert.deepEqual(compareFixture(files, fixture), []);
    });
  }

  it('leaves no fixture directory without a case', () => {
    assert.deepEqual(orphanFixtureDirectories(files, report.fixtures), []);
  });
});
