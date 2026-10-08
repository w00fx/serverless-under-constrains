// Golden shape parity of the transport probe (design §12.4, §14; AC-RUA-002, AC-RUA-021): what the
// real probe workload executor freezes in the offline probe cloud has the shape of the golden
// builder's `probe` base, so the golden probe cases judge evidence the runner can actually produce.
// The probe directory holds the same files with the same record types and field sets, its journals
// have the same source structure, and the runner records the same probe events with the same
// fields. The executor adds only what the golden base leaves out by design: the derived transport
// probe result and the evidence index, the `trial_evidence_frozen` event, the
// coordination journal and its prefix checkpoint (BR-RUA-044), and the admission core files every
// index covers. The golden base's `phase_transition_recorded` events are the execution runner's
// (CMP-05), not the probe workload's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { serializeScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import { buildBaseScenario } from '../../support/golden-builder/scenario-builder.ts';
import { OfflineProbeCloud } from '../../support/offline-cloud/offline-probe-cloud.ts';
import { textField } from './support/frozen-trial-files.ts';
import { frozenProbeReport } from './support/frozen-probe-files.ts';
import { fieldShape, packageRecords, sourceStructure } from './support/package-shape.ts';
import type { PackageFiles } from './support/package-shape.ts';

const DIRECTORY = 'probe';
const DERIVED_FILES = ['derived/transport-probe-result.json', 'evidence-index.json'];
const EXECUTION_FILES_ADDED = [
  EXECUTION_PATHS.deploymentAssemblyInventory,
  EXECUTION_PATHS.environmentInput,
  EXECUTION_PATHS.oracleRevisionCheck,
  EXECUTION_PATHS.sourceProvenance,
  EXECUTION_PATHS.coordinationJournal,
  EXECUTION_PATHS.coordinationPrefixCheckpoint,
];

function goldenProbe(): PackageFiles {
  const built = buildBaseScenario('probe');
  assert.ok(built.ok, 'the probe base builds');
  assert.equal(built.value.subject_directory, DIRECTORY);
  const files = serializeScenarioFiles(built.value.files);
  assert.ok(files.ok, 'the probe base serializes');
  return files.value;
}

async function frozenOfflineProbe(): Promise<{ readonly files: PackageFiles; readonly probeId: string }> {
  const cloud = new OfflineProbeCloud();
  await cloud.startExecution();
  frozenProbeReport(await cloud.runProbe());
  return { files: cloud.packageFiles(), probeId: cloud.identity.transport_probe_id };
}

// The execution runner's own events (CMP-05); every other runner event is the probe workload's.
const EXECUTION_RUNNER_EVENTS: readonly unknown[] = ['phase_transition_recorded'];

function probeRunnerEventsOf(files: PackageFiles): readonly JsonObject[] {
  return packageRecords(files.get(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array()).filter(
    (event) => !EXECUTION_RUNNER_EVENTS.includes(event['record_type']),
  );
}

describe('the offline transport probe matches the golden probe base shapes', () => {
  it('probe: same files, record types, field sets, source structure and runner events', async () => {
    const golden = goldenProbe();
    const offline = await frozenOfflineProbe();

    const probeFiles = (files: PackageFiles): readonly string[] =>
      [...files.keys()].filter((path) => path.startsWith(`${DIRECTORY}/`)).sort();
    const derived = DERIVED_FILES.map((file) => `${DIRECTORY}/${file}`);
    assert.deepEqual(probeFiles(offline.files), [...probeFiles(golden), ...derived].sort());
    assert.deepEqual(
      probeFiles(offline.files).filter((path) => path.startsWith(`${DIRECTORY}/queues/`)),
      [],
    );
    assert.deepEqual(fieldShape(offline.files, DIRECTORY, DERIVED_FILES), fieldShape(golden, DIRECTORY, DERIVED_FILES));
    assert.deepEqual(sourceStructure(offline.files, DIRECTORY), sourceStructure(golden, DIRECTORY));

    const executionFiles = (files: PackageFiles): readonly string[] =>
      [...files.keys()].filter((path) => !path.startsWith(`${DIRECTORY}/`)).sort();
    assert.deepEqual(executionFiles(offline.files), [...executionFiles(golden), ...EXECUTION_FILES_ADDED].sort());

    const types = (events: readonly JsonObject[]): readonly string[] =>
      events.map((event) => textField(event, 'record_type'));
    const offlineRunner = probeRunnerEventsOf(offline.files);
    const goldenRunner = probeRunnerEventsOf(golden);
    assert.ok(goldenRunner.length > 0, 'the golden probe base records probe events');
    assert.deepEqual(types(offlineRunner), [...types(goldenRunner), 'trial_evidence_frozen']);
    const fields = (events: readonly JsonObject[], type: string): string =>
      Object.keys(events.find((event) => event['record_type'] === type) ?? {})
        .sort()
        .join(',');
    for (const type of types(goldenRunner)) {
      assert.equal(fields(offlineRunner, type), fields(goldenRunner, type), type);
    }
    assert.equal(new Set(offlineRunner.map((event) => event['source_instance_id'])).size, 1);
    assert.ok(offlineRunner.every((event) => event['transport_probe_id'] === offline.probeId));
    assert.ok(goldenRunner.every((event) => event['transport_probe_id'] === offline.probeId));
  });
});
