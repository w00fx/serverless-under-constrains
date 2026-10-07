// `late-evidence assess <package>` (BR-RUA-043, D-16; design §8.13; AC-RUA-030): late evidence of a
// finalized package is preserved in a LATE_EVIDENCE amendment that the package verifier selects and
// finds whole (no integrity reason names it; the offline original's own reasons are outside this
// service), from the packaged stream or from a re-capture over the execution's tables, chained to
// every amendment already stored, and the original package is never rewritten. Every package the service
// cannot amend truthfully is refused with a reason and nothing written: one not finalized, one whose
// original assessment or stream cannot be read, one whose frozen evidence the assessment rejects,
// and a capture that fails.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LateEvidenceAmendmentDeps } from '../../../src/execution-lifecycle/late-evidence-amendment.ts';
import { assessLateEvidenceAmendment } from '../../../src/execution-lifecycle/late-evidence-amendment.ts';
import type { AdmittedExecution, ExecutionServices } from '../../../src/execution-lifecycle/execution-ports.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import { readAmendmentSnapshots, readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import type { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { RefusingPackageStorage } from './fakes/refusing-package-storage.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';
import { RunnerWorld } from './support/runner-world.ts';

const LATE_CANARY_EVENT_ID = 'cccccccc-0000-4000-8000-0000000000fe';

const probe = await ProbeRunnerWorld.create();
assert.equal((await probe.run()).package_finalized, true);
const run = await RunnerWorld.create();
assert.equal((await run.run()).package_finalized, true);

interface FinishedExecution {
  readonly admitted: AdmittedExecution;
  readonly services: ExecutionServices;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly store: InMemoryItemStore;
  readonly capture: NonNullable<LateEvidenceAmendmentDeps['capture']>;
  readonly drive: <T>(work: Promise<T>) => Promise<T>;
}

const PROBE: FinishedExecution = {
  admitted: probe.admitted,
  services: probe.services,
  files: probe.cloud.packageFiles(),
  store: probe.cloud.store,
  capture: { store: probe.cloud.store, dlq: probe.deps.readers.dlq, durable: probe.deps.readers.durable },
  drive: (work) => probe.drive(work),
};
const RUN: FinishedExecution = {
  admitted: run.admitted,
  services: run.services,
  files: run.cloud.packageFiles(),
  store: run.cloud.store,
  capture: { store: run.cloud.store, dlq: run.cloud.dlqReceiver, durable: run.cloud.durable },
  drive: (work) => run.drive(work),
};

// The finished package, edited, in storage of its own; the original worlds stay untouched.
async function storedPackage<S extends OfflinePackageStorage>(
  execution: FinishedExecution,
  storage: S,
  edit: (files: Map<string, Uint8Array>) => void = () => undefined,
): Promise<S> {
  const files = new Map(execution.files);
  edit(files);
  for (const [path, bytes] of files) {
    await storage.writeOnce(`${execution.admitted.package_directory}/${path}`, bytes);
  }
  return storage;
}

function amend(
  execution: FinishedExecution,
  storage: OfflinePackageStorage,
  capture?: LateEvidenceAmendmentDeps['capture'],
): ReturnType<typeof assessLateEvidenceAmendment> {
  const deps = { files: storage, services: execution.services, ...(capture === undefined ? {} : { capture }) };
  return execution.drive(assessLateEvidenceAmendment(execution.admitted, deps));
}

function amendmentFiles(storage: OfflinePackageStorage, execution: FinishedExecution): ReadonlyMap<string, Uint8Array> {
  return storage.filesUnder(PACKAGE_LAYOUT.amendmentsDirectory(execution.admitted.identity));
}

function jsonAt(files: ReadonlyMap<string, Uint8Array>, path: string): JsonObject {
  const bytes = files.get(path);
  assert.ok(bytes !== undefined, `${path} is written`);
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
}

function codes(reasons: readonly { readonly code: string }[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

// The package verifier's reading of the package with the amendment chain ending at `head`.
async function verified(
  storage: OfflinePackageStorage,
  execution: FinishedExecution,
  head: Sha256Hex,
): Promise<JsonObject> {
  const { identity } = execution.admitted;
  const original = await readPackageSnapshot(storage, identity);
  const amendments = await readAmendmentSnapshots(storage, identity);
  assert.ok(original.ok && amendments.ok);
  const verification = verifyPackage(
    {
      identity,
      original: original.value,
      amendments: amendments.value,
      selected_head: head,
      referenced_package_indexes: [],
      evaluated_at: formatUtcMillis(execution.services.clock.now()),
    },
    { validator: lifecycleValidator(), digest: sha256Hex },
  );
  return verification as unknown as JsonObject;
}

// One more controller canary acknowledgement, written to the canary partition after the package
// froze: a late record the capture keeps uncorrelated (readiness evidence, never a verdict input).
function seedLateCanary(store: InMemoryItemStore): void {
  const frozen = store.itemsIn('experiment_journal').find((item) => item.pk.endsWith('#canary'));
  assert.ok(frozen !== undefined, 'the run journaled its canary acknowledgement');
  const late: StoredItem = {
    ...frozen,
    event_id: LATE_CANARY_EVENT_ID,
    source_sequence: 2,
    sk: frozen.sk.replace(/#\d+$/, '#000000000002'),
  };
  store.seed('experiment_journal', late);
}

describe('AC-RUA-030 late-evidence assess writes a LATE_EVIDENCE amendment', () => {
  it('reassesses the probe packaged stream into an amendment the verifier finds whole and selects', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage());
    const before = new Map(storage.filesUnder(PROBE.admitted.package_directory));
    const amended = await amend(PROBE, storage);
    assert.ok(amended.ok, JSON.stringify(amended));
    assert.equal(amended.value.source, 'packaged_stream');
    assert.match(amended.value.amendment_directory, /\/0001-/);
    const written = storage.filesUnder(amended.value.amendment_directory);
    assert.deepEqual(
      [...written.keys()].toSorted(),
      [
        AMENDMENT_PATHS.amendmentIndex,
        AMENDMENT_PATHS.lateEvidenceAssessment,
        AMENDMENT_PATHS.lateEvidenceStream,
      ].toSorted(),
    );
    const stream = written.get(AMENDMENT_PATHS.lateEvidenceStream) ?? new Uint8Array([1]);
    assert.deepEqual(stream, PROBE.files.get(EXECUTION_PATHS.lateEvidenceStream));
    const assessment = jsonAt(written, AMENDMENT_PATHS.lateEvidenceAssessment);
    assert.equal(lifecycleValidator().validateAs('late_evidence_assessment', assessment as JsonValue).valid, true);
    assert.deepEqual(assessment, JSON.parse(JSON.stringify(amended.value.assessment)));
    assert.equal(assessment['late_evidence_status'], 'none');
    assert.equal(assessment['monitoring'], 'complete', 'the original monitoring window is kept');
    const original = jsonAt(PROBE.files, EXECUTION_PATHS.lateEvidenceAssessment);
    assert.equal(assessment['monitoring_started_at'], original['monitoring_started_at']);
    assert.equal(assessment['monitoring_ended_at'], original['monitoring_ended_at']);
    const refs = assessment['evidence_refs'] as readonly JsonObject[];
    assert.deepEqual(
      refs.filter((ref) => ref['artifact_path'] === AMENDMENT_PATHS.lateEvidenceStream),
      [{ artifact_path: AMENDMENT_PATHS.lateEvidenceStream, artifact_sha256: sha256Hex(stream) }],
    );
    assert.ok(refs.every((ref) => ref['artifact_path'] !== EXECUTION_PATHS.lateEvidenceStream));
    const index = jsonAt(written, AMENDMENT_PATHS.amendmentIndex);
    assert.equal(index['amendment_kind'], 'LATE_EVIDENCE');
    assert.equal(index['sequence'], 1);
    assert.equal(index['parent_amendment_index_sha256'], null);
    assert.equal(
      index['original_package_index_sha256'],
      sha256Hex(PROBE.files.get(EXECUTION_PATHS.packageIndex) ?? new Uint8Array()),
    );
    const head = sha256Hex(written.get(AMENDMENT_PATHS.amendmentIndex) ?? new Uint8Array());
    const verification = await verified(storage, PROBE, head);
    const reasons = (verification['package_ineligibility_reasons'] ?? []) as readonly JsonObject[];
    assert.deepEqual(
      reasons.filter((reason) => JSON.stringify(reason).includes('amendments/')),
      [],
      'the amendment is whole',
    );
    assert.equal((verification['selected_chain'] as readonly JsonObject[]).length, 1);
    assert.deepEqual(
      new Map(storage.filesUnder(PROBE.admitted.package_directory)),
      before,
      'the package is never rewritten',
    );
  });

  it('re-captures a run over its tables, carrying the late record into the payload', async () => {
    seedLateCanary(RUN.store);
    const storage = await storedPackage(RUN, new OfflinePackageStorage());
    const amended = await amend(RUN, storage, RUN.capture);
    assert.ok(amended.ok, JSON.stringify(amended));
    assert.equal(amended.value.source, 'capture');
    const written = storage.filesUnder(amended.value.amendment_directory);
    const stream = new TextDecoder().decode(written.get(AMENDMENT_PATHS.lateEvidenceStream));
    assert.notEqual(stream, '', 'the late canary acknowledgement is captured');
    assert.ok(stream.includes(LATE_CANARY_EVENT_ID));
    assert.equal(stream.split('\n').filter((line) => line !== '').length, 1);
    const assessment = jsonAt(written, AMENDMENT_PATHS.lateEvidenceAssessment);
    assert.equal(lifecycleValidator().validateAs('late_evidence_assessment', assessment as JsonValue).valid, true);
    assert.equal(assessment['execution_manifest_sha256'], RUN.admitted.manifest_sha256);
    assert.equal(
      (assessment['reassessments'] as readonly JsonObject[]).length,
      RUN.admitted.manifest.trials.length,
      'every frozen trial is reassessed',
    );
    assert.deepEqual(RUN.files, run.cloud.packageFiles(), 'the finished package is only read');
  });

  it('chains a second amendment to the first', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage());
    const first = await amend(PROBE, storage);
    const second = await amend(PROBE, storage, PROBE.capture);
    assert.ok(first.ok && second.ok);
    assert.match(second.value.amendment_directory, /\/0002-/);
    const firstIndex = storage.filesUnder(first.value.amendment_directory).get(AMENDMENT_PATHS.amendmentIndex);
    const secondIndex = jsonAt(storage.filesUnder(second.value.amendment_directory), AMENDMENT_PATHS.amendmentIndex);
    assert.equal(secondIndex['sequence'], 2);
    assert.equal(secondIndex['parent_amendment_index_sha256'], sha256Hex(firstIndex ?? new Uint8Array()));
    const verification = await verified(
      storage,
      PROBE,
      sha256Hex(
        storage.filesUnder(second.value.amendment_directory).get(AMENDMENT_PATHS.amendmentIndex) ?? new Uint8Array(),
      ),
    );
    assert.equal((verification['selected_chain'] as readonly JsonObject[]).length, 2);
  });

  it('captures a run without DLQ targets when the frozen manifest names none or is absent', async () => {
    const manifest = JSON.parse(new TextDecoder().decode(run.resourceManifestBytes)) as JsonObject;
    const noOutputs = await storedPackage(RUN, new OfflinePackageStorage(), (files) => {
      files.set(
        EXECUTION_PATHS.resourceManifest,
        new TextEncoder().encode(`${JSON.stringify({ ...manifest, outputs: [] })}\n`),
      );
    });
    const absent = await storedPackage(RUN, new OfflinePackageStorage(), (files) => {
      files.delete(EXECUTION_PATHS.resourceManifest);
    });
    for (const storage of [noOutputs, absent]) {
      const amended = await amend(RUN, storage, RUN.capture);
      assert.ok(amended.ok, JSON.stringify(amended));
      assert.equal(amended.value.source, 'capture');
    }
  });
});

describe('late-evidence assess refuses what it cannot amend truthfully', () => {
  async function refused(
    execution: FinishedExecution,
    storage: OfflinePackageStorage,
    capture?: LateEvidenceAmendmentDeps['capture'],
  ): Promise<readonly string[]> {
    const amended = await amend(execution, storage, capture);
    assert.ok(!amended.ok, 'refused');
    assert.equal(amendmentFiles(storage, execution).size, 0, 'nothing is written');
    return codes(amended.error);
  }

  it('refuses a package that was never finalized', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.delete(EXECUTION_PATHS.packageIndex);
    });
    assert.deepEqual(await refused(PROBE, storage), ['PACKAGE_NOT_FINALIZED']);
  });

  it('refuses a package it cannot list', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage());
    storage.failNextLists(1);
    assert.deepEqual(await refused(PROBE, storage), ['PACKAGE_UNREADABLE']);
  });

  it('refuses a package whose original assessment is absent or unreadable', async () => {
    const absent = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.delete(EXECUTION_PATHS.lateEvidenceAssessment);
    });
    assert.deepEqual(await refused(PROBE, absent), ['ORIGINAL_ASSESSMENT_UNREADABLE']);
    const unreadable = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.set(EXECUTION_PATHS.lateEvidenceAssessment, new TextEncoder().encode('{"record_type":1}\n'));
    });
    const amended = await amend(PROBE, unreadable);
    assert.ok(!amended.ok);
    assert.match(
      amended.error[0]?.detail ?? '',
      /late-evidence-assessment\.json is \w+; expected the original assessment/,
    );
  });

  it('refuses a package without a stream when no capture readers are given', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.delete(EXECUTION_PATHS.lateEvidenceStream);
    });
    assert.deepEqual(await refused(PROBE, storage), ['LATE_STREAM_ABSENT']);
  });

  it('refuses a capture that fails, instead of amending with an empty stream', async () => {
    const storage = await storedPackage(PROBE, new OfflinePackageStorage());
    PROBE.store.scriptReadFault('ProvisionedThroughputExceededException', { operation: 'queryPartitionPage' });
    const reasons = await refused(PROBE, storage, PROBE.capture);
    assert.equal(reasons.at(-1), 'LATE_CAPTURE_FAILED');
    assert.ok(reasons.length > 1, 'the capture reasons are kept');
    assert.equal(PROBE.store.pendingFaultCount(), 0);
  });

  it('refuses a package whose frozen probe result the assessment cannot read', async () => {
    const result = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');
    const storage = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.set(result, new TextEncoder().encode('not json\n'));
    });
    assert.deepEqual(await refused(PROBE, storage), ['FROZEN_RESULT_UNREADABLE']);
  });

  it('refuses a probe whose frozen manifest names no probe targets to re-derive the result from', async () => {
    const golden = probe.cloud.frozen.core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
    const unnamed = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.set(EXECUTION_PATHS.resourceManifest, golden);
    });
    assert.deepEqual(await refused(PROBE, unnamed, PROBE.capture), ['FROZEN_PROBE_INPUT_UNREADABLE']);
    const absent = await storedPackage(PROBE, new OfflinePackageStorage(), (files) => {
      files.delete(EXECUTION_PATHS.resourceManifest);
    });
    assert.deepEqual(await refused(PROBE, absent, PROBE.capture), ['FROZEN_PROBE_INPUT_UNREADABLE']);
  });

  it('reports an amendment it could not write', async () => {
    const storage = await storedPackage(PROBE, new RefusingPackageStorage());
    storage.refuseWritesUnder(`${PACKAGE_LAYOUT.amendmentsDirectory(PROBE.admitted.identity)}/`);
    const amended = await amend(PROBE, storage);
    assert.ok(!amended.ok);
    assert.deepEqual(codes(amended.error), ['AMENDMENT_NOT_WRITTEN']);
    assert.match(amended.error[0]?.detail ?? '', /expected the LATE_EVIDENCE amendment written whole/);
  });
});
