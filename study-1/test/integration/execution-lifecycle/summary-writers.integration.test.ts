// The P9 summary writers of a probe and of a variant validation over packages their runners really
// wrote (design §10.2; CTR-RUA-003, BR-RUA-038; AC-RUA-025, AC-RUA-035, AC-RUA-036, AC-RUA-056):
// each rewrites exactly what the runner wrote from the same package, reads its closure records
// only when they belong to the execution's manifest, cannot be written without the records it
// cites, and reports each trial or the probe result as the package froze it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionPackage } from '../../../src/execution-lifecycle/execution-package.ts';
import type { AdmittedExecution } from '../../../src/execution-lifecycle/execution-ports.ts';
import type { SummaryWriter } from '../../../src/execution-lifecycle/execution-finalization.ts';
import { summaryWriterFor } from '../../../src/execution-lifecycle/summary-writers.ts';
import { TransportProbeSummaryWriter } from '../../../src/execution-lifecycle/probe-summary-writer.ts';
import { ValidationSummaryWriter } from '../../../src/execution-lifecycle/validation-summary-writer.ts';
import { RunSummaryWriter } from '../../../src/execution-lifecycle/execution-finalization.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { leaseEvent } from '../../unit/study-comparison/support/runner-events.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';
import { RunnerWorld } from './support/runner-world.ts';

type PackageFiles = Map<string, Uint8Array>;

const probeWorld = await ProbeRunnerWorld.create();
await probeWorld.run();
const validationWorld = await RunnerWorld.create({ name: 'validation-conventional' });
await validationWorld.run();

const PROBE_SUMMARY = probeWorld.record(EXECUTION_PATHS.transportProbeSummary);
const VALIDATION_SUMMARY = validationWorld.record(EXECUTION_PATHS.validationSummary);
const FINALIZED_AT_PROBE = PROBE_SUMMARY['created_at'] as UtcMillis;
const FINALIZED_AT_VALIDATION = VALIDATION_SUMMARY['created_at'] as UtcMillis;
const PROBE_RESULT = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');
const PROBE_INDEX = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'evidenceIndex');
const [CONTROL, TREATMENT] =
  validationWorld.admitted.identity.execution_kind === 'VARIANT_VALIDATION'
    ? validationWorld.admitted.manifest.trials
    : [];
assert.ok(CONTROL !== undefined && TREATMENT !== undefined, 'the validation declares two trials');
const CONTROL_UNIT = { kind: 'trial', trial_id: CONTROL.trial_id } as const;
const TREATMENT_UNIT = { kind: 'trial', trial_id: TREATMENT.trial_id } as const;

// The package as it stood before P9 wrote its summary and the index.
function beforeSummary(files: ReadonlyMap<string, Uint8Array>, summaryPath: string): PackageFiles {
  return new Map([...files].filter(([path]) => path !== summaryPath && path !== EXECUTION_PATHS.packageIndex));
}

interface WriterWorld {
  readonly storage: OfflinePackageStorage;
  readonly pkg: ExecutionPackage;
  readonly admitted: AdmittedExecution;
}

async function packageOf(files: PackageFiles, admitted: AdmittedExecution): Promise<WriterWorld> {
  const storage = new OfflinePackageStorage();
  for (const [path, bytes] of files) {
    await storage.writeOnce(`${admitted.package_directory}/${path}`, bytes);
  }
  return { storage, pkg: new ExecutionPackage(storage, admitted.identity, admitted.package_directory), admitted };
}

function probePackage(edit: (files: PackageFiles) => void = () => undefined): Promise<WriterWorld> {
  const files = beforeSummary(probeWorld.cloud.packageFiles(), EXECUTION_PATHS.transportProbeSummary);
  edit(files);
  return packageOf(files, probeWorld.admitted);
}

function validationPackage(edit: (files: PackageFiles) => void = () => undefined): Promise<WriterWorld> {
  const files = beforeSummary(validationWorld.cloud.packageFiles(), EXECUTION_PATHS.validationSummary);
  edit(files);
  return packageOf(files, validationWorld.admitted);
}

async function written(
  world: WriterWorld,
  writer: SummaryWriter,
  path: string,
  at: UtcMillis,
): Promise<{ readonly reasons: readonly string[]; readonly summary: JsonObject | undefined }> {
  const reasons = await writer.write(world.pkg, world.admitted, at);
  const bytes = world.storage.filesUnder(world.admitted.package_directory).get(path);
  // A refused write leaves whatever was there; only a written summary is read back.
  const summary =
    bytes === undefined || reasons.length > 0 ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as JsonObject);
  if (summary !== undefined) {
    assert.equal(lifecycleValidator().validate(summary as JsonValue).valid, true);
  }
  return { reasons: reasons.map((reason) => reason.code), summary };
}

// A summary the writer must have written without a reason.
async function recordOf(result: ReturnType<typeof written>): Promise<JsonObject> {
  const { reasons, summary } = await result;
  assert.deepEqual(reasons, []);
  assert.ok(summary !== undefined);
  return summary;
}

function probeRecord(world: WriterWorld): Promise<JsonObject> {
  return recordOf(probeSummary(world));
}

function validationRecord(world: WriterWorld): Promise<JsonObject> {
  return recordOf(validationSummary(world));
}

function probeSummary(world: WriterWorld): ReturnType<typeof written> {
  return written(
    world,
    new TransportProbeSummaryWriter(lifecycleValidator()),
    EXECUTION_PATHS.transportProbeSummary,
    FINALIZED_AT_PROBE,
  );
}

function validationSummary(world: WriterWorld): ReturnType<typeof written> {
  return written(
    world,
    new ValidationSummaryWriter(lifecycleValidator()),
    EXECUTION_PATHS.validationSummary,
    FINALIZED_AT_VALIDATION,
  );
}

function withRecord(files: PackageFiles, path: string, change: (record: JsonObject) => JsonObject): void {
  const record = JSON.parse(new TextDecoder().decode(files.get(path))) as JsonObject;
  files.set(path, new TextEncoder().encode(`${JSON.stringify(change(record))}\n`));
}

function appendLine(files: PackageFiles, path: string, record: JsonObject): void {
  const before = files.get(path) ?? new Uint8Array();
  files.set(path, new Uint8Array([...before, ...new TextEncoder().encode(`${JSON.stringify(record)}\n`)]));
}

const OTHER_MANIFEST = 'f'.repeat(64);

describe('TransportProbeSummaryWriter', () => {
  it('rewrites exactly the summary the runner wrote', async () => {
    const { reasons, summary } = await probeSummary(await probePackage());
    assert.deepEqual(reasons, []);
    assert.deepEqual(summary, PROBE_SUMMARY);
  });

  it('cannot be written without the cleanup result and the late-evidence assessment', async () => {
    const world = await probePackage((files) => {
      files.delete(EXECUTION_PATHS.cleanupResult);
      files.delete(EXECUTION_PATHS.lateEvidenceAssessment);
    });
    const reasons = await new TransportProbeSummaryWriter(lifecycleValidator()).write(
      world.pkg,
      world.admitted,
      FINALIZED_AT_PROBE,
    );
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['SUMMARY_INPUT_MISSING', EXECUTION_PATHS.cleanupResult],
        ['SUMMARY_INPUT_MISSING', EXECUTION_PATHS.lateEvidenceAssessment],
      ],
    );
    assert.match(reasons[0]?.detail ?? '', /is absent or unreadable; expected it frozen before the summary/);
  });

  it('treats a cleanup result of another manifest as absent', async () => {
    const world = await probePackage((files) => {
      withRecord(files, EXECUTION_PATHS.cleanupResult, (record) => ({
        ...record,
        execution_manifest_sha256: OTHER_MANIFEST,
      }));
    });
    const { reasons, summary } = await probeSummary(world);
    assert.deepEqual(reasons, ['SUMMARY_INPUT_MISSING']);
    assert.equal(summary, undefined);
  });

  it('omits the digest and ends PROBE_INCOMPLETE when the result has no evidence index', async () => {
    const summary = await probeRecord(await probePackage((files) => files.delete(PROBE_INDEX)));
    assert.equal(summary['probe_terminal_reason'], 'PROBE_INCOMPLETE');
    assert.equal(Object.hasOwn(summary, 'probe_result_sha256'), false);
  });

  it('reads an absent audit as inconclusive and absent safety as unverified', async () => {
    const summary = await probeRecord(
      await probePackage((files) => {
        files.delete(EXECUTION_PATHS.leakAuditResult);
        files.delete(EXECUTION_PATHS.safetyAssessment);
      }),
    );
    assert.equal(summary['leak_audit_status'], 'inconclusive');
    assert.equal(summary['probe_terminal_reason'], 'LEAK_AUDIT_NOT_CLEAN');
    assert.equal(summary['probe_result_sha256'], sha256Hex(probeWorld.file(PROBE_RESULT) ?? new Uint8Array()));
    assert.equal(summary['safety_status'], 'unverified');
  });

  it('ends CLEANUP_INCOMPLETE over a failed cleanup', async () => {
    const summary = await probeRecord(
      await probePackage((files) => {
        withRecord(files, EXECUTION_PATHS.cleanupResult, (record) => ({ ...record, cleanup_status: 'failed' }));
      }),
    );
    assert.equal(summary['probe_terminal_reason'], 'CLEANUP_INCOMPLETE');
    assert.equal(summary['cleanup_status'], 'failed');
  });

  it('settles the lease status from the coordination journal of this manifest only', async () => {
    const released = (manifest: string): JsonObject => {
      const { run_id: _run, ...event } = leaseEvent('RELEASED', 59);
      return {
        ...event,
        transport_probe_id: probeWorld.cloud.identity.transport_probe_id,
        owner_kind: 'TRANSPORT_PROBE',
        owner_id: probeWorld.cloud.identity.transport_probe_id,
        owner_manifest_sha256: manifest,
        execution_manifest_sha256: manifest,
      };
    };
    const own = await probeRecord(
      await probePackage((files) => {
        appendLine(files, EXECUTION_PATHS.coordinationJournal, released(probeWorld.admitted.manifest_sha256));
      }),
    );
    assert.equal(own['lease_status'], 'released');
    const foreign = await probeRecord(
      await probePackage((files) => {
        appendLine(files, EXECUTION_PATHS.coordinationJournal, released(OTHER_MANIFEST));
      }),
    );
    assert.equal(foreign['lease_status'], 'unverified');
  });

  it('fails over a package it cannot list, and over a summary already written', async () => {
    const unlisted = await probePackage();
    unlisted.storage.failNextLists(1);
    assert.deepEqual((await probeSummary(unlisted)).reasons, ['PACKAGE_UNREADABLE']);
    const rewritten = await probePackage((files) =>
      files.set(EXECUTION_PATHS.transportProbeSummary, new Uint8Array([1])),
    );
    assert.deepEqual((await probeSummary(rewritten)).reasons, ['PACKAGE_FILE_NOT_WRITTEN']);
  });
});

describe('ValidationSummaryWriter', () => {
  it('rewrites exactly the summary the runner wrote: AC-RUA-036 indeterminate operational closure', async () => {
    const summary = await validationRecord(await validationPackage());
    assert.deepEqual(summary, VALIDATION_SUMMARY);
    assert.equal(summary['validation_terminal_reason'], 'LEASE_STATE_UNVERIFIED');
    assert.equal(summary['implementation_validation_status'], 'indeterminate');
    assert.equal(Object.hasOwn(summary, 'run_id'), false, 'a validation makes no cross-variant claim');
  });

  it('maps each frozen trial one to one, citing the stored result bytes', async () => {
    const summary = await validationRecord(await validationPackage());
    const entries = summary['trial_results'] as readonly JsonObject[];
    assert.deepEqual(
      entries.map((entry) => [entry['trial_id'], entry['execution_status'], entry['scenario']]),
      [
        [CONTROL.trial_id, 'completed', 'CONTROL'],
        [TREATMENT.trial_id, 'completed', 'COMMIT_THEN_TIMEOUT'],
      ],
    );
    const controlResult = PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'oracleResult');
    assert.deepEqual(entries[0]?.['oracle_result_ref'], {
      artifact_path: controlResult,
      artifact_sha256: sha256Hex(validationWorld.file(controlResult) ?? new Uint8Array()),
    });
    assert.equal(summary['evidence_integrity_status'], 'verified');
  });

  it('reports a started trial without a result as incomplete, and one never started as not started', async () => {
    const summary = await validationRecord(
      await validationPackage((files) => {
        files.delete(PACKAGE_LAYOUT.unitFile(TREATMENT_UNIT, 'oracleResult'));
        files.delete(PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'oracleResult'));
        files.delete(PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'trialManifest'));
      }),
    );
    const entries = summary['trial_results'] as readonly JsonObject[];
    const codes = (entry: JsonObject | undefined): readonly JsonValue[] =>
      (entry?.['incompletion_reasons'] as readonly JsonObject[]).map((reason) => reason['code'] ?? null);
    assert.equal(entries[0]?.['execution_status'], 'not_started');
    assert.deepEqual(codes(entries[0]), ['TRIAL_NOT_STARTED']);
    assert.equal(entries[1]?.['execution_status'], 'incomplete');
    assert.deepEqual(codes(entries[1]), ['TRIAL_NOT_FROZEN']);
    assert.equal(summary['evidence_integrity_status'], 'unverified');
  });

  it('reads an absent leak audit as inconclusive', async () => {
    const summary = await validationRecord(
      await validationPackage((files) => {
        files.delete(EXECUTION_PATHS.leakAuditResult);
      }),
    );
    assert.equal(summary['leak_audit_status'], 'inconclusive');
  });

  it('evaluates a frozen result whose trial manifest is absent, naming the missing evidence', async () => {
    const summary = await validationRecord(
      await validationPackage((files) => {
        files.delete(PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'trialManifest'));
      }),
    );
    const entries = summary['trial_results'] as readonly JsonObject[];
    assert.equal(entries[0]?.['execution_status'], 'completed');
    assert.ok(
      JSON.stringify(summary).includes(`the trial manifest of trial ${CONTROL.trial_id} is absent or unreadable`),
    );
  });

  it("never reports another trial's oracle result as this trial's", async () => {
    const summary = await validationRecord(
      await validationPackage((files) => {
        const other = files.get(PACKAGE_LAYOUT.unitFile(TREATMENT_UNIT, 'oracleResult')) ?? new Uint8Array();
        files.set(PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'oracleResult'), other);
      }),
    );
    const entries = summary['trial_results'] as readonly JsonObject[];
    assert.equal(entries[0]?.['execution_status'], 'incomplete');
  });

  it('names every result its evidence index does not anchor', async () => {
    const anchorReasons = async (edit: (files: PackageFiles) => void): Promise<readonly string[]> => {
      const summary = await validationRecord(await validationPackage(edit));
      return (summary['status_reasons'] as readonly JsonObject[])
        .filter((reason) => reason['code'] === 'CRYPTOGRAPHIC_ANCHOR_MISSING')
        .map((reason) => JSON.stringify(reason['detail']));
    };
    const controlIndex = PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'evidenceIndex');
    const treatmentIndex = PACKAGE_LAYOUT.unitFile(TREATMENT_UNIT, 'evidenceIndex');
    assert.deepEqual(await anchorReasons(() => undefined), []);
    const missing = await anchorReasons((files) => files.delete(controlIndex));
    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? '', /is absent; expected a evidence_index record/);
    const foreign = await anchorReasons((files) =>
      files.set(controlIndex, files.get(treatmentIndex) ?? new Uint8Array()),
    );
    assert.match(foreign[0] ?? '', /is not the evidence index of trial/);
    const otherValidation = await anchorReasons((files) => {
      withRecord(files, controlIndex, (index) => ({
        ...index,
        variant_validation_id: '00000000-0000-4000-8000-0000000000aa',
      }));
    });
    assert.equal(otherValidation.length, 1, 'an index of another validation anchors nothing');
    assert.match(otherValidation[0] ?? '', /is not the evidence index of trial .* of validation /);
    const stale = await anchorReasons((files) => {
      withRecord(files, controlIndex, (index) => ({
        ...index,
        entries: (index['entries'] as readonly JsonObject[]).map((entry) =>
          entry['artifact_path'] === PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'oracleResult')
            ? { ...entry, sha256: OTHER_MANIFEST }
            : entry,
        ),
      }));
    });
    assert.match(stale[0] ?? '', /lists digest f+ for .*expected it listed with the stored digest/);
    const unlisted = await anchorReasons((files) => {
      withRecord(files, controlIndex, (index) => ({
        ...index,
        entries: (index['entries'] as readonly JsonObject[]).filter(
          (entry) => entry['artifact_path'] !== PACKAGE_LAYOUT.unitFile(CONTROL_UNIT, 'oracleResult'),
        ),
      }));
    });
    assert.match(unlisted[0] ?? '', /does not list .*oracle-result\.json/);
  });

  it('takes the terminal reason from the journals in time order and the lease status they settle', async () => {
    const identity = validationWorld.admitted.identity;
    assert.ok(identity.execution_kind === 'VARIANT_VALIDATION');
    const { run_id: _run, ...released } = leaseEvent('RELEASED', 59);
    const summary = await validationRecord(
      await validationPackage((files) => {
        appendLine(files, EXECUTION_PATHS.coordinationJournal, {
          ...released,
          variant_validation_id: identity.variant_validation_id,
          owner_kind: 'VARIANT_VALIDATION',
          owner_id: identity.variant_validation_id,
          owner_manifest_sha256: validationWorld.admitted.manifest_sha256,
          execution_manifest_sha256: validationWorld.admitted.manifest_sha256,
        });
      }),
    );
    assert.equal(summary['lease_status'], 'released');
    assert.equal(summary['validation_terminal_reason'], 'COMPLETED');
  });

  it('cannot be written without the cleanup result, the late assessment or the safety assessment', async () => {
    const { reasons, summary } = await validationSummary(
      await validationPackage((files) => files.delete(EXECUTION_PATHS.safetyAssessment)),
    );
    assert.deepEqual(reasons, ['SUMMARY_INPUT_MISSING']);
    assert.equal(summary, undefined);
  });

  it('refuses a package whose admission cannot be read, one it cannot list, and a second summary', async () => {
    const unadmitted = await validationPackage((files) => files.delete(EXECUTION_PATHS.executionManifest));
    assert.deepEqual((await validationSummary(unadmitted)).reasons, ['ADMISSION_INVALID']);
    const unlisted = await validationPackage();
    unlisted.storage.failNextLists(1);
    assert.deepEqual((await validationSummary(unlisted)).reasons, ['PACKAGE_UNREADABLE']);
    const rewritten = await validationPackage((files) =>
      files.set(EXECUTION_PATHS.validationSummary, new Uint8Array([1])),
    );
    assert.deepEqual((await validationSummary(rewritten)).reasons, ['PACKAGE_FILE_NOT_WRITTEN']);
  });
});

describe('summary writers refuse an execution of another kind', () => {
  it('names the kind it was handed and the kind it writes', async () => {
    const probe = await probePackage();
    const validation = await validationPackage();
    const onValidation = await new TransportProbeSummaryWriter(lifecycleValidator()).write(
      validation.pkg,
      validation.admitted,
      FINALIZED_AT_PROBE,
    );
    assert.deepEqual(
      onValidation.map((reason) => reason.code),
      ['SUMMARY_KIND_MISMATCH'],
    );
    assert.match(onValidation[0]?.detail ?? '', /handed a VARIANT_VALIDATION execution; expected TRANSPORT_PROBE/);
    const onProbe = await new ValidationSummaryWriter(lifecycleValidator()).write(
      probe.pkg,
      probe.admitted,
      FINALIZED_AT_PROBE,
    );
    assert.match(onProbe[0]?.detail ?? '', /handed a TRANSPORT_PROBE execution; expected VARIANT_VALIDATION/);
  });

  it('binds each kind to its own writer', () => {
    const validator = lifecycleValidator();
    assert.ok(summaryWriterFor('RUN', validator) instanceof RunSummaryWriter);
    assert.ok(summaryWriterFor('TRANSPORT_PROBE', validator) instanceof TransportProbeSummaryWriter);
    assert.ok(summaryWriterFor('VARIANT_VALIDATION', validator) instanceof ValidationSummaryWriter);
  });
});
