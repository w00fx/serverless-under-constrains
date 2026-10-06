// Golden shape parity (design §12.4, §14): what the real trial executor freezes in the offline
// cloud has the shape of the golden builder's base fixtures, so the golden cases judge evidence the
// runner can actually produce. For each conventional base, the subject trial directory holds the
// same files with the same record types and field sets, its journals have the same source
// structure, and the runner journal records the same trial events. The executor adds only what
// golden bases leave out by design: the derived files and the evidence index (trial-files.ts), the
// `trial_evidence_frozen` event, and the admission core files every index covers. Durable bases
// are out of reach offline (offline-cloud.ts); the runner records one source instance per trial
// where the golden builder keeps one per execution (evidence/WP-26/decisions.md).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { serializeScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import type { BaseScenarioId } from '../../support/golden-builder/golden-plan.ts';
import { buildBaseScenario } from '../../support/golden-builder/scenario-builder.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import type { OfflineExecutionName } from '../../support/offline-cloud/offline-execution.ts';
import { textField } from './support/frozen-trial-files.ts';

const decoder = new TextDecoder();
const DERIVED_FILES = ['derived/attempt-projection.json', 'derived/oracle-result.json', 'evidence-index.json'];
const ADMISSION_CORE_FILES = [
  EXECUTION_PATHS.deploymentAssemblyInventory,
  EXECUTION_PATHS.environmentInput,
  EXECUTION_PATHS.oracleRevisionCheck,
  EXECUTION_PATHS.sourceProvenance,
];

interface ParityCase {
  readonly base: BaseScenarioId;
  readonly execution: OfflineExecutionName;
  /** The offline trials to run; the last is the base's subject. */
  readonly sequences: readonly number[];
}

const CASES: readonly ParityCase[] = [
  { base: 'run-conventional-control', execution: 'run', sequences: [1] },
  { base: 'run-conventional-treatment', execution: 'run', sequences: [1, 3] },
  { base: 'validation-conventional-control', execution: 'validation-conventional', sequences: [1] },
  { base: 'validation-conventional-treatment', execution: 'validation-conventional', sequences: [1, 2] },
];

type Files = ReadonlyMap<string, Uint8Array>;

function records(bytes: Uint8Array): readonly JsonObject[] {
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

// Record type -> sorted union of field names, per file of a directory.
function fieldShape(files: Files, directory: string): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const shape: Record<string, Record<string, string>> = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(`${directory}/`) || DERIVED_FILES.some((derived) => path.endsWith(derived))) {
      continue;
    }
    const byType = new Map<string, Set<string>>();
    for (const record of records(bytes)) {
      const type = textField(record, 'record_type');
      byType.set(type, new Set([...(byType.get(type) ?? []), ...Object.keys(record)]));
    }
    shape[path.slice(directory.length + 1)] = Object.fromEntries(
      [...byType]
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([type, fields]) => [type, [...fields].sort().join(',')]),
    );
  }
  return shape;
}

// Per journal file of a directory: source -> number of source instances.
function sourceStructure(files: Files, directory: string): Readonly<Record<string, string>> {
  const structure: Record<string, string> = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(`${directory}/journals/`)) {
      continue;
    }
    const instances = new Map<string, Set<string>>();
    for (const event of records(bytes)) {
      const source = textField(event, 'source');
      instances.set(source, new Set([...(instances.get(source) ?? []), textField(event, 'source_instance_id')]));
    }
    structure[path] = [...instances]
      .map(([source, ids]) => `${source}:${String(ids.size)}`)
      .sort()
      .join(',');
  }
  return structure;
}

function runnerEventsOf(files: Files, trialId: string): readonly JsonObject[] {
  return records(files.get(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array()).filter(
    (event) => event['trial_id'] === trialId,
  );
}

async function frozenOffline(parity: ParityCase): Promise<{ files: Files; trialId: string }> {
  const cloud = new OfflineCloud(parity.execution);
  await cloud.startExecution();
  let trialId = '';
  for (const sequence of parity.sequences) {
    const report = await cloud.runTrial(sequence);
    assert.equal(report.kind, 'frozen');
    trialId = report.trial_id;
  }
  return { files: cloud.packageFiles(), trialId };
}

function goldenBase(base: BaseScenarioId): { files: Files; directory: string } {
  const built = buildBaseScenario(base);
  assert.ok(built.ok, `${base} builds`);
  const files = serializeScenarioFiles(built.value.files);
  assert.ok(files.ok, `${base} serializes`);
  return { files: files.value, directory: built.value.subject_directory };
}

describe('offline trial execution matches the golden base fixture shapes', () => {
  for (const parity of CASES) {
    it(`${parity.base}: same files, record types, field sets and source structure`, async () => {
      const golden = goldenBase(parity.base);
      const offline = await frozenOffline(parity);
      const directory = `trials/${offline.trialId}`;
      assert.equal(directory, golden.directory);

      const subjectFiles = (files: Files): readonly string[] =>
        [...files.keys()].filter((path) => path.startsWith(`${directory}/`)).sort();
      const derived = DERIVED_FILES.map((file) => `${directory}/${file}`);
      assert.deepEqual(subjectFiles(offline.files), [...subjectFiles(golden.files), ...derived].sort());
      assert.deepEqual(fieldShape(offline.files, directory), fieldShape(golden.files, directory));
      assert.deepEqual(sourceStructure(offline.files, directory), sourceStructure(golden.files, directory));

      const executionFiles = (files: Files): readonly string[] =>
        [...files.keys()].filter((path) => !path.startsWith('trials/')).sort();
      assert.deepEqual(
        executionFiles(offline.files),
        [...executionFiles(golden.files), ...ADMISSION_CORE_FILES].sort(),
      );

      const types = (events: readonly JsonObject[]): readonly string[] =>
        [...new Set(events.map((event) => textField(event, 'record_type')))].sort();
      const offlineRunner = runnerEventsOf(offline.files, offline.trialId);
      const goldenRunner = runnerEventsOf(golden.files, offline.trialId);
      assert.deepEqual(types(offlineRunner), [...types(goldenRunner), 'trial_evidence_frozen'].sort());
      assert.equal(new Set(offlineRunner.map((event) => event['source_instance_id'])).size, 1);
      assert.deepEqual(
        offlineRunner.map((event) => event['source_sequence']),
        offlineRunner.map((_, index) => index + 1),
      );
    });
  }
});
