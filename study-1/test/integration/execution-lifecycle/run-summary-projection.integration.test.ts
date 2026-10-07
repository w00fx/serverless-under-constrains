// AC-RUA-009 at P9 (Owner amendment A-13; BR-RUA-007, BR-RUA-020): the run summary writer reads the
// deployment projection from the run template the execution manifest froze, at its package-relative
// `template_path` and checked against its `template_sha256`, so the template-derived equality
// projections are judged from evidence instead of staying indeterminate. A template that is not in
// the package or does not match its pinned digest leaves them indeterminate without failing P9.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import { ExecutionPackage } from '../../../src/execution-lifecycle/execution-package.ts';
import {
  frozenDeploymentProjection,
  RunSummaryWriter,
} from '../../../src/execution-lifecycle/execution-finalization.ts';
import type { AdmittedExecution } from '../../../src/execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { FrozenDeploymentAssembly } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import { runTemplate, templateBytes } from '../../support/deployment-assembly/execution-template-fixture.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { RunnerWorld } from './support/runner-world.ts';

const world = await RunnerWorld.create();
await world.run();
const FINALIZED_AT = world.record(EXECUTION_PATHS.runSummary)['created_at'] as UtcMillis;
const TEMPLATE = templateBytes(runTemplate());
const ASSEMBLY = world.admitted.manifest.deployment_assembly;
const PINNED: FrozenDeploymentAssembly = { ...ASSEMBLY, template_sha256: sha256Hex(TEMPLATE) };

// The run's package before P9, with the frozen template placed where the manifest pins it.
async function comparisonWith(admitted: AdmittedExecution, template: Uint8Array | undefined): Promise<JsonObject> {
  const storage = new OfflinePackageStorage();
  const before = [...world.cloud.packageFiles()].filter(
    ([path]) =>
      path !== EXECUTION_PATHS.runSummary &&
      path !== EXECUTION_PATHS.comparisonAssessment &&
      path !== EXECUTION_PATHS.packageIndex,
  );
  for (const [path, bytes] of [
    ...before,
    ...(template === undefined ? [] : [[ASSEMBLY.template_path, template] as const]),
  ]) {
    await storage.writeOnce(`${admitted.package_directory}/${path}`, bytes);
  }
  const pkg = new ExecutionPackage(storage, admitted.identity, admitted.package_directory);
  assert.deepEqual(await new RunSummaryWriter(lifecycleValidator()).write(pkg, admitted, FINALIZED_AT), []);
  const bytes = storage.filesUnder(admitted.package_directory).get(EXECUTION_PATHS.comparisonAssessment);
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
}

// The projection cites the template by the digest of its bytes.
function citesTemplate(assessment: JsonObject): boolean {
  return JSON.stringify(assessment).includes(sha256Hex(TEMPLATE));
}

describe('AC-RUA-009 the run summary reads the frozen deployment projection', () => {
  it('judges the template-derived projections from the pinned template', async () => {
    const pinned = { ...world.admitted, manifest: { ...world.admitted.manifest, deployment_assembly: PINNED } };
    const projected = await comparisonWith(pinned, TEMPLATE);
    const unprojected = await comparisonWith(world.admitted, undefined);
    assert.equal(citesTemplate(projected), true);
    assert.equal(citesTemplate(unprojected), false);
    assert.notDeepEqual(projected, unprojected);
  });

  it('leaves the projections indeterminate over a template that is not the pinned one', async () => {
    const mismatched = await comparisonWith(world.admitted, TEMPLATE);
    const absent = await comparisonWith(world.admitted, undefined);
    assert.deepEqual(mismatched, absent);
  });
});

describe('frozenDeploymentProjection', () => {
  it('is the projection of the pinned template at its package-relative path', () => {
    const files = new Map([[ASSEMBLY.template_path, TEMPLATE]]);
    const expected = projectDeploymentTemplate({
      template_path: ASSEMBLY.template_path,
      template_bytes: TEMPLATE,
      template_sha256: PINNED.template_sha256,
    });
    assert.ok(expected.ok);
    assert.deepEqual(frozenDeploymentProjection(files, PINNED), expected.value);
  });

  it('is undefined when the template is absent or does not match its digest', () => {
    assert.equal(frozenDeploymentProjection(new Map(), PINNED), undefined);
    const files = new Map([[ASSEMBLY.template_path, TEMPLATE]]);
    assert.equal(
      frozenDeploymentProjection(files, { ...PINNED, template_sha256: 'c'.repeat(64) as Sha256Hex }),
      undefined,
    );
  });
});

describe('RunSummaryWriter over a package it cannot read as a run', () => {
  it('names the missing execution manifest and writes no summary', async () => {
    const storage = new OfflinePackageStorage();
    for (const [path, bytes] of world.cloud.packageFiles()) {
      if (path !== EXECUTION_PATHS.executionManifest && path !== EXECUTION_PATHS.runSummary) {
        await storage.writeOnce(`${world.admitted.package_directory}/${path}`, bytes);
      }
    }
    const pkg = new ExecutionPackage(storage, world.admitted.identity, world.admitted.package_directory);
    const reasons = await new RunSummaryWriter(lifecycleValidator()).write(pkg, world.admitted, FINALIZED_AT);
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['ARTIFACT_MISSING', EXECUTION_PATHS.executionManifest]],
    );
    assert.equal(storage.filesUnder(world.admitted.package_directory).has(EXECUTION_PATHS.runSummary), false);
  });
});
