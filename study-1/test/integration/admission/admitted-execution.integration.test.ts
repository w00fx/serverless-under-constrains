// An admissible execution is admitted (BR-RUA-039..042, BR-RUA-019, BR-RUA-028, BR-RUA-046,
// BR-RUA-055; design §10.1 A1..A15, §9.8 S1-S2). Every step passes and is journaled in order;
// the package's `admission/` directory holds the validated records, the exact environment input
// and schema copies, the frozen assembly copy and its inventory, the attempt journal, and the
// execution manifest, which is written last: when any earlier file cannot be written the attempt
// fails and no manifest exists. Admission performs no cloud mutation.
//
// Boundary: the production `admitExecution` over the admission harness (named fakes, the real
// synthesizer over a scripted CDK CLI, the real scope recomputation, the memory file system).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { ExecutionKind, JsonObject, VariantId } from '../../../src/record-contract/primitives.ts';
import { RUN_TRIAL_ORDER } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { ACCOUNT_ID, COMMIT_SHA, EVIDENCE_ROOT, environmentBytes } from '../../support/admission/admission-fixtures.ts';
import { AdmissionHarness, harnessId } from '../../support/admission/admission-harness.ts';

const CASES: readonly {
  readonly name: string;
  readonly kind: ExecutionKind;
  readonly variant?: VariantId;
  readonly trials: number;
  readonly cost: string;
}[] = [
  { name: 'transport-probe-admitted', kind: 'TRANSPORT_PROBE', trials: 0, cost: '0.03' },
  { name: 'run-admitted', kind: 'RUN', trials: 4, cost: '0.28' },
  { name: 'durable-validation-admitted', kind: 'VARIANT_VALIDATION', variant: 'durable', trials: 2, cost: '0.22' },
  {
    name: 'conventional-validation-admitted',
    kind: 'VARIANT_VALIDATION',
    variant: 'conventional',
    trials: 2,
    cost: '0.18',
  },
];

function packageDirectory(outcome: Extract<AdmissionOutcome, { readonly kind: 'admitted' }>): string {
  return outcome.manifest_path.slice(0, -EXECUTION_PATHS.executionManifest.length);
}

async function storedRecord(harness: AdmissionHarness, path: string): Promise<JsonObject> {
  const parsed = parseJsonDocument(await harness.evidenceFile(path));
  assert.ok(parsed.ok && isJsonObject(parsed.value), `${path} is a JSON object`);
  return parsed.value;
}

describe('an admissible execution is admitted with its manifest written last', () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const harness = await AdmissionHarness.create(testCase.kind, testCase.variant);
      const outcome = await harness.admit();
      assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome));
      assert.equal(outcome.admission_attempt_id, harnessId(1));
      const directory = packageDirectory(outcome);
      const manifest = await storedRecord(harness, outcome.manifest_path);
      assert.equal(harness.validator.validateAs('execution_manifest', manifest).valid, true);
      assert.equal(sha256Hex(await harness.evidenceFile(outcome.manifest_path)), outcome.manifest_sha256);
      assert.equal(manifest['seed'], 1);
      assert.equal((manifest['trials'] as readonly unknown[]).length, testCase.trials);
      assert.deepEqual(manifest['estimates'], {
        ...(manifest['estimates'] as JsonObject),
        estimated_cost_usd: testCase.cost,
      });
      const environment = manifest['environment'] as JsonObject;
      assert.equal(environment['account_id'], ACCOUNT_ID);
      assert.equal(environment['environment_input_sha256'], sha256Hex(environmentBytes()));
      assert.equal((manifest['source'] as JsonObject)['commit_sha'], COMMIT_SHA);
      assert.deepEqual(
        await harness.evidenceFile(`${directory}${EXECUTION_PATHS.environmentInput}`),
        environmentBytes(),
      );
      const inventory = await storedRecord(harness, `${directory}${EXECUTION_PATHS.deploymentAssemblyInventory}`);
      const assembly = manifest['deployment_assembly'] as JsonObject;
      assert.equal(assembly['inventory_sha256'], inventory['inventory_sha256']);
      assert.equal(
        assembly['template_sha256'],
        sha256Hex(await harness.evidenceFile(`${directory}${assembly['template_path'] as string}`)),
      );
      const checks = harness.journalRecords(outcome.admission_attempt_id);
      assert.deepEqual(
        checks.map((record) => (isJsonObject(record) ? [record['check_id'], record['result']] : [])),
        Array.from({ length: 15 }, (_, index) => [`A${String(index + 1)}`, 'passed']),
      );
      const journalCopy = await harness.evidenceFile(`${directory}${EXECUTION_PATHS.preflightJournal}`);
      assert.equal(new TextDecoder().decode(journalCopy).split('\n').filter(Boolean).length, 15);
      assert.equal(harness.journalFinalized(outcome.admission_attempt_id), true);
      assert.equal(harness.runner.invocations().length, 1, 'the assembly is synthesized exactly once');
      assert.deepEqual(harness.mutationLog.entries(), [], 'admission mutates nothing in the cloud');
    });
  }

  it('run-declares-trials-in-order-with-the-selected-probe', async () => {
    const harness = await AdmissionHarness.create('RUN');
    const outcome = await harness.admit();
    assert.ok(outcome.kind === 'admitted');
    const manifest = await storedRecord(harness, outcome.manifest_path);
    const trials = manifest['trials'] as readonly JsonObject[];
    assert.deepEqual(
      trials.map(({ sequence, variant_id, scenario }) => ({ sequence, variant_id, scenario })),
      RUN_TRIAL_ORDER,
    );
    assert.deepEqual(
      trials.map((trial) => trial['trial_id']),
      [harnessId(3), harnessId(4), harnessId(5), harnessId(6)],
    );
    assert.deepEqual(manifest['qualification'], {
      transport_probe_id: harness.selection().transport_probe_id,
      original_package_index_sha256: harness.selection().original_package_index_sha256,
    });
    assert.equal(manifest['transport_scope_snapshot_sha256'], harness.selected?.snapshot_sha256);
    assert.equal((manifest['declared_variant_differences'] as readonly unknown[]).length, 1);
  });

  it('detached-head-admitted-without-a-branch', async () => {
    const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
    harness.git.detachHead();
    const outcome = await harness.admit();
    assert.ok(outcome.kind === 'admitted');
    const manifest = await storedRecord(harness, outcome.manifest_path);
    assert.equal(Object.hasOwn(manifest['source'] as JsonObject, 'branch'), false);
    const provenance = await storedRecord(harness, `${packageDirectory(outcome)}${EXECUTION_PATHS.sourceProvenance}`);
    assert.equal(provenance['detached_head'], true);
    assert.equal(harness.validator.validateAs('source_provenance', provenance).valid, true);
  });

  it('manifest-written-after-every-other-package-file', async () => {
    const reference = await AdmissionHarness.create('RUN');
    const admitted = await reference.admit();
    assert.ok(admitted.kind === 'admitted');
    const others = (await reference.packagePaths()).filter((path) => path !== admitted.manifest_path);
    const schemaCopies = others.filter((path) => path.includes('/admission/schemas/'));
    const probed = [
      ...others.filter((path) => !path.includes('/admission/schemas/')),
      ...schemaCopies.slice(0, 1),
      ...schemaCopies.slice(-1),
    ];
    assert.ok(probed.length >= 10, JSON.stringify(probed));
    for (const path of probed) {
      const harness = await AdmissionHarness.create('RUN');
      harness.files.failCreate(`${EVIDENCE_ROOT}/${path}`);
      const outcome = await harness.admit();
      assert.equal(outcome.kind, 'failed', `${path}: ${JSON.stringify(outcome)}`);
      assert.equal(
        (await harness.packagePaths()).includes(admitted.manifest_path),
        false,
        `the manifest exists although ${path} was not written`,
      );
    }
  });
});
