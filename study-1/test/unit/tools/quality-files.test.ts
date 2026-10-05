// The committed quality files (design §5.4, §12.1, §15.4): they parse, they declare all 29
// features, the configs match the issued mutation-target policy, and the kernel's suite
// minimums cover at least the cases §14 lists for WP-00 (AC-RUA-048: 7 unit cases;
// AC-RUA-046: 7 serialization-rule contract cases and the parser fuzz targets).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkModuleBoundaries, parseBoundaryConfig } from '../../../tools/lib/module-boundaries.ts';
import { parseEquivalences } from '../../../tools/lib/mutation-report.ts';
import { parseMutationTargetPolicy, qualityConfigDrift } from '../../../tools/lib/quality-config.ts';
import type { JsonRecord } from '../../../tools/lib/quality-config.ts';
import { extractImports } from '../../../tools/lib/source-imports.ts';
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

  it('declare exactly the same-layer edges of design §5.4 plus Owner amendment A-01', () => {
    const config = parseBoundaryConfig(readJson('quality/module-boundaries.json'));
    assert.deepEqual(config.same_layer_edges, [
      { from: 'durable-variant', to: 'conventional-variant', paths: ['request-state/'] },
      { from: 'transport-qualification', to: 'treatment-fidelity' },
      { from: 'trial-oracle', to: 'treatment-fidelity' },
      { from: 'admission', to: 'deployment-assembly', type_only: true },
      { from: 'event-journal', to: 'durable-store', type_only: true },
    ]);
    assert.equal(config.layers['event-journal'], 1);
    assert.equal(config.layers['durable-store'], 1);
  });

  it('let event-journal import durable-store types only, and never the reverse (A-01)', () => {
    const config = parseBoundaryConfig(readJson('quality/module-boundaries.json'));
    const rulesOf = (path: string, text: string): readonly string[] =>
      checkModuleBoundaries(config, [{ path, text, imports: extractImports(path, text) }]).map(
        (violation) => `${violation.rule}: ${violation.detail}`,
      );
    const journal = 'src/event-journal/journal-port.ts';
    assert.deepEqual(rulesOf(journal, "import type { ItemKey } from '../durable-store/item-store-port.ts';"), []);
    assert.deepEqual(rulesOf(journal, "import { type ItemKey } from '../durable-store/item-store-port.ts';"), []);
    assert.deepEqual(
      rulesOf(journal, "import { type ItemKey, createItemStore } from '../durable-store/item-store-port.ts';"),
      [
        'EDGE_REQUIRES_TYPE_ONLY: ../durable-store/item-store-port.ts is a value import; the event-journal -> durable-store edge allows type-only imports',
      ],
    );
    assert.deepEqual(rulesOf(journal, "import { createItemStore } from '../durable-store/item-store.ts';"), [
      'EDGE_REQUIRES_TYPE_ONLY: ../durable-store/item-store.ts is a value import; the event-journal -> durable-store edge allows type-only imports',
    ]);
    assert.deepEqual(rulesOf('src/durable-store/s.ts', "import type { JournalEntry } from '../event-journal/j.ts';"), [
      'OUTWARD_IMPORT: durable-store (L1) imports event-journal (L1) via ../event-journal/j.ts; expected a strictly lower layer or a declared same-layer edge',
    ]);
    assert.deepEqual(rulesOf('src/attempt-lifecycle/a.ts', "import type { ItemKey } from '../durable-store/p.ts';"), [
      'OUTWARD_IMPORT: attempt-lifecycle (L1) imports durable-store (L1) via ../durable-store/p.ts; expected a strictly lower layer or a declared same-layer edge',
    ]);
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
