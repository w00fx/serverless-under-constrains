// The transport probe lifecycle through `runProbe` (design §10.2 P1-P9; BR-RUA-027, BR-RUA-043,
// BR-RUA-044, CTR-RUA-003; AC-RUA-021, AC-RUA-030, AC-RUA-056): the golden probe runs end to end
// over the offline probe cloud with the real probe workload executor behind the ProbeRunner
// binding. P4 runs the probe, P5 freezes its result and the coordination prefix checkpoint, the
// late capture re-reads the probe partition, the late assessment re-derives the frozen result, and
// the transport probe summary names the terminal reason and the frozen result's digest. Every way
// the probe can stop early keeps the summary truthful: no digest without a frozen result, and the
// earliest stopping cause as the terminal reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import { assessProbeUsability } from '../../../src/transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { OfflineProvisioner } from './fakes/offline-provisioner.ts';
import { ScriptedProbeRunner } from './fakes/scripted-probe-runner.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';

const PROBE = { kind: 'probe' } as const;
const RESULT_PATH = PACKAGE_LAYOUT.unitFile(PROBE, 'transportProbeResult');

// The golden probe resource manifest bytes, which name no probe caller output.
function goldenResourceManifest(world: ProbeRunnerWorld): Uint8Array {
  return world.cloud.frozen.core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
}

function summaryOf(world: ProbeRunnerWorld): JsonObject {
  const summary = world.record(EXECUTION_PATHS.transportProbeSummary);
  assert.equal(lifecycleValidator().validateAs('transport_probe_summary', summary as JsonValue).valid, true);
  return summary;
}

const completed = await ProbeRunnerWorld.create();
const completedOutcome = await completed.run();

describe('AC-RUA-021 runProbe drives the transport probe through P1-P9', () => {
  it('runs P4, freezes P5 with the coordination prefix checkpoint and finalizes the package', () => {
    assert.equal(completedOutcome.package_finalized, true);
    assert.equal(completedOutcome.probe?.kind, 'frozen');
    assert.deepEqual(completedOutcome.trials, []);
    assert.deepEqual(completedOutcome.reasons, []);
    assert.deepEqual(completed.phases(), [
      'LEASE_ACQUISITION:started',
      'LEASE_ACQUISITION:succeeded',
      'PROVISIONING:started',
      'PROVISIONING:succeeded',
      'READINESS:started',
      'READINESS:succeeded',
      'TRIALS:started',
      'PROBE_FREEZE:started',
      'TRIALS:succeeded',
      'PROBE_FREEZE:succeeded',
      'LATE_MONITORING:started',
      'LATE_MONITORING:succeeded',
      'CLEANUP:started',
      'CLEANUP:succeeded',
      'LEASE_FINALIZATION:started',
      'LEASE_FINALIZATION:succeeded',
      'SUMMARY:started',
      'SUMMARY:succeeded',
    ]);
    const checkpoint = completed.record(EXECUTION_PATHS.coordinationPrefixCheckpoint);
    const journal = completed.file(EXECUTION_PATHS.coordinationJournal) ?? new Uint8Array();
    const prefix = checkpoint['prefix_byte_count'];
    assert.ok(typeof prefix === 'number' && prefix > 0 && prefix <= journal.length);
    const index = completed.record(PACKAGE_LAYOUT.unitFile(PROBE, 'evidenceIndex'));
    const listed = (index['entries'] as readonly JsonObject[]).map((entry) => entry['artifact_path']);
    assert.ok(listed.includes(EXECUTION_PATHS.coordinationPrefixCheckpoint));
  });

  it('plans the probe from the deployed probe caller version the targets name', () => {
    const request = completed.record(PACKAGE_LAYOUT.unitFile(PROBE, 'providerTrialConfiguration'));
    assert.equal(request['execution_manifest_sha256'], completed.admitted.manifest_sha256);
    assert.equal(completed.targets.probe_caller?.version, '1');
  });

  it('writes a COMPLETED summary carrying the frozen result digest and the closure', () => {
    const summary = summaryOf(completed);
    const result = completed.file(RESULT_PATH) ?? new Uint8Array();
    const late = completed.file(EXECUTION_PATHS.lateEvidenceAssessment) ?? new Uint8Array();
    assert.equal(summary['probe_terminal_reason'], 'COMPLETED');
    assert.equal(summary['probe_result_sha256'], sha256Hex(result));
    assert.equal(summary['transport_probe_id'], completed.cloud.identity.transport_probe_id);
    assert.equal(summary['execution_manifest_sha256'], completed.admitted.manifest_sha256);
    assert.equal(summary['cleanup_status'], 'succeeded');
    assert.equal(summary['leak_audit_status'], 'clean');
    // The scripted lease journals no release, so the coordination journal never settles it.
    assert.equal(summary['lease_status'], 'unverified');
    assert.equal(summary['late_evidence_status'], 'none');
    assert.deepEqual(summary['late_evidence_assessment_ref'], {
      artifact_path: EXECUTION_PATHS.lateEvidenceAssessment,
      artifact_sha256: sha256Hex(late),
    });
  });
});

describe('AC-RUA-030 the probe late evidence is captured and re-derived', () => {
  it('captures an empty stream and reproduces the frozen result with no change', () => {
    assert.deepEqual(completed.file(EXECUTION_PATHS.lateEvidenceStream), new Uint8Array());
    const assessment = completed.record(EXECUTION_PATHS.lateEvidenceAssessment);
    assert.equal(assessment['late_evidence_status'], 'none');
    assert.equal(assessment['monitoring'], 'complete');
    const reassessments = assessment['reassessments'] as readonly JsonObject[];
    assert.equal(reassessments.length, 1);
    const reassessment = reassessments[0] ?? {};
    assert.deepEqual(reassessment['changes'], []);
    assert.equal(reassessment['status'], 'none');
    assert.deepEqual(reassessment['frozen_result_ref'], {
      artifact_path: RESULT_PATH,
      artifact_sha256: sha256Hex(completed.file(RESULT_PATH) ?? new Uint8Array()),
    });
  });
});

describe('AC-RUA-056 the finalized probe carries what usability judges', () => {
  it('records the known safety breach, so the passing probe is not usable', async () => {
    // The golden probe manifest estimates USD 1.25 against the USD 1.00 probe ceiling (OR-RUA-004).
    const summary = summaryOf(completed);
    assert.equal(summary['safety_status'], 'breached');
    const { identity } = completed.cloud;
    const original = await readPackageSnapshot(completed.cloud.storage, identity);
    assert.ok(original.ok);
    const facts = readProbeUsabilityInput(
      {
        identity,
        original: original.value,
        amendments: [],
        selected_head: null,
        referenced_package_indexes: [],
        evaluated_at: formatUtcMillis(completed.cloud.time.now()),
      },
      { validator: lifecycleValidator(), digest: sha256Hex },
    );
    const usability = assessProbeUsability(facts);
    assert.equal(usability.probe_usability, 'not_usable');
    assert.ok(JSON.stringify(usability.reasons).includes('safety'));
  });
});

describe('runProbe stops early with a truthful summary', () => {
  it('ends PROBE_INCOMPLETE without a digest when the probe never started', async () => {
    const probe = new ScriptedProbeRunner('not_started');
    const world = await ProbeRunnerWorld.create({ deps: () => ({ probe }) });
    const outcome = await world.run();
    assert.equal(outcome.package_finalized, true);
    assert.equal(probe.plans().length, 1);
    assert.equal(probe.plans()[0]?.probe_caller_version, '1');
    assert.ok(world.phases().includes('TRIALS:failed'));
    assert.ok(world.phases().includes('PROBE_FREEZE:skipped'));
    const summary = summaryOf(world);
    assert.equal(summary['probe_terminal_reason'], 'PROBE_INCOMPLETE');
    assert.equal(Object.hasOwn(summary, 'probe_result_sha256'), false);
  });

  it('ends EVIDENCE_FINALIZATION_FAILED when the freeze fails after the checkpoint', async () => {
    const probe = new ScriptedProbeRunner('freeze_failed');
    const world = await ProbeRunnerWorld.create({ deps: () => ({ probe }) });
    await world.run();
    assert.deepEqual(probe.checkpoints(), [undefined]);
    assert.ok(world.phases().includes('PROBE_FREEZE:failed'));
    assert.ok(world.file(EXECUTION_PATHS.coordinationPrefixCheckpoint) !== undefined);
    const summary = summaryOf(world);
    assert.equal(summary['probe_terminal_reason'], 'EVIDENCE_FINALIZATION_FAILED');
    assert.equal(Object.hasOwn(summary, 'probe_result_sha256'), false);
  });

  it('ends OPERATOR_ABORT when the operator aborts during the probe', async () => {
    const world: ProbeRunnerWorld = await ProbeRunnerWorld.create({
      deps: (built) => ({ probe: new ScriptedProbeRunner('not_started', () => built.runner.abort('SIGINT')) }),
    });
    const outcome = await world.run();
    assert.equal(outcome.interruption?.cause, 'OPERATOR_ABORT');
    assert.equal(summaryOf(world)['probe_terminal_reason'], 'OPERATOR_ABORT');
    assert.equal(world.file(EXECUTION_PATHS.lateEvidenceStream), undefined, 'monitoring was skipped');
  });

  it('ends LEASE_LOST when the lease is lost during the probe', async () => {
    const world: ProbeRunnerWorld = await ProbeRunnerWorld.create({
      deps: (built) => ({
        probe: new ScriptedProbeRunner('not_started', () => {
          built.lease.lose();
        }),
      }),
    });
    const outcome = await world.run();
    assert.equal(outcome.interruption?.cause, 'LEASE_LOST');
    assert.equal(summaryOf(world)['probe_terminal_reason'], 'LEASE_LOST');
  });

  it('hands nothing over when the deployed stack names no probe caller', async () => {
    const probe = new ScriptedProbeRunner();
    const world: ProbeRunnerWorld = await ProbeRunnerWorld.create({
      deps: (built) => {
        const { probe_caller: _dropped, ...targets } = built.targets;
        const bytes = goldenResourceManifest(built);
        return {
          probe,
          provisioner: new OfflineProvisioner({ bytes, targets, log: built.account.log, files: built.cloud.storage }),
        };
      },
    });
    const outcome = await world.run();
    assert.deepEqual(probe.plans(), []);
    assert.ok(outcome.reasons.some((reason) => reason.detail.includes('probe_caller_version')));
    assert.ok(world.phases().includes('TRIALS:failed'));
    assert.ok(world.phases().includes('PROBE_FREEZE:skipped'));
    assert.equal(summaryOf(world)['probe_terminal_reason'], 'PROBE_INCOMPLETE');
  });

  it('hands nothing over once the lease was lost before the probe could start', async () => {
    const probe = new ScriptedProbeRunner();
    const world: ProbeRunnerWorld = await ProbeRunnerWorld.create({
      deps: (built) => ({
        probe,
        provisioner: new OfflineProvisioner({
          bytes: goldenResourceManifest(built),
          targets: built.targets,
          log: built.account.log,
          files: built.cloud.storage,
          during: (): void => {
            built.lease.lose();
          },
        }),
      }),
    });
    await world.run();
    assert.deepEqual(probe.plans(), []);
    assert.equal(summaryOf(world)['probe_terminal_reason'], 'LEASE_LOST');
  });
});

describe('the run commands of another kind refuse a probe', () => {
  for (const command of ['runValidation', 'runCanonical'] as const) {
    it(`${command} names the mismatch and acquires nothing`, async () => {
      const world = await ProbeRunnerWorld.create();
      const before = world.cloud.packageFiles();
      const outcome = await world.runner[command]();
      assert.equal(outcome.package_finalized, false);
      assert.deepEqual(
        outcome.reasons.map((reason) => reason.code),
        ['EXECUTION_KIND_MISMATCH'],
      );
      assert.match(outcome.reasons[0]?.detail ?? '', /admits a TRANSPORT_PROBE; expected a /);
      assert.deepEqual(world.lease.calls(), []);
      assert.deepEqual(world.cloud.packageFiles(), before);
    });
  }
});
