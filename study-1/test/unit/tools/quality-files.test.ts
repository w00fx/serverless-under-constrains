// The committed quality files (design §5.4, §12.1, §15.4): they parse, they declare all 29
// features, the configs match the issued mutation-target policy, and the kernel's suite
// minimums cover at least the cases §14 lists for WP-00 (AC-RUA-048: 7 unit cases;
// AC-RUA-046: 7 serialization-rule contract cases and the parser fuzz targets).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseBoundaryConfig } from '../../../tools/lib/module-boundaries.ts';
import { parseEquivalences } from '../../../tools/lib/mutation-report.ts';
import { parseMutationTargetPolicy, qualityConfigDrift } from '../../../tools/lib/quality-config.ts';
import type { JsonRecord } from '../../../tools/lib/quality-config.ts';
import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(`${STUDY_ROOT}${path}`, 'utf8'));

describe('committed quality files', () => {
  it('declare the 29 features of the module map in layers L0-L7', () => {
    const config = parseBoundaryConfig(readJson('quality/module-boundaries.json'));
    assert.equal(Object.keys(config.layers).length, 29);
    assert.equal(config.layers['record-contract'], 0);
    assert.equal(config.layers['operator-cli'], 7);
    assert.deepEqual(config.infra_may_import, ['record-contract']);
    assert.deepEqual(config.src_may_import_infra, ['infra/ownership/']);
  });

  it('keep the coverage and mutation configs in sync with the mutation-target policy', () => {
    const policy = parseMutationTargetPolicy(readJson('quality/mutation-targets.json'));
    assert.deepEqual(policy.include, ['src/**/*.ts', 'tools/lib/**/*.ts']);
    assert.deepEqual(
      qualityConfigDrift(policy, readJson('.c8rc.json') as JsonRecord, readJson('stryker.config.json') as JsonRecord),
      [],
    );
  });

  it('hold only human-approved mutation equivalences', () => {
    for (const entry of parseEquivalences(readJson('quality/mutation-equivalences.json'))) {
      assert.notEqual(entry.approved_by ?? '', '');
      assert.notEqual(entry.approved_at ?? '', '');
    }
  });

  it('set the kernel suite minimums at or above the cases §14 lists', () => {
    const minimums = parseSuiteMinimums(
      'record-contract-kernel.json',
      readJson('quality/suite-minimums/record-contract-kernel.json'),
    );
    assert.ok((minimums.unit ?? 0) >= 7);
    assert.ok((minimums.contract ?? 0) >= 7);
    assert.ok((minimums.fuzz ?? 0) >= 2);
    assert.ok((minimums.integration ?? 0) >= 1);
  });
});
