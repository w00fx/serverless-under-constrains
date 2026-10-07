// `rua late-evidence assess` over the real `assessLateEvidenceAmendment` and the offline cloud
// (design §8.13, §11; BR-RUA-043, BR-RUA-044; AC-RUA-030): the stream is the packaged one when the
// effective closure proves the execution's tables gone (a clean cleanup, or a whole clean
// recovery), and a re-capture over the tables otherwise; the amendment index is the written path
// and the assessment the result record. An unfinalized package is refused (5); an amendments
// directory that cannot be read or written is an evidence failure (10).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessLateEvidenceAmendment } from '../../../src/execution-lifecycle/late-evidence-amendment.ts';
import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import { LateEvidenceAssessCommand } from '../../../src/operator-cli/late-evidence-command.ts';
import type { LateEvidenceRequest } from '../../../src/operator-cli/late-evidence-command.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import type { CliRun } from '../../unit/operator-cli/support/cli-harness.ts';
import { STORED_EVIDENCE_ROOT, packageOperand } from '../../unit/operator-cli/support/stored-packages.ts';
import { RefusingPackageStorage } from '../execution-lifecycle/fakes/refusing-package-storage.ts';
import { lifecycleValidator } from '../execution-lifecycle/support/execution-fixtures.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { copyEvidence, leakedExecution, recoveredExecution } from './support/offline-executions.ts';

interface Assessment {
  readonly run: CliRun;
  readonly requests: readonly LateEvidenceRequest[];
}

// Runs the command with the service bound to the world's offline tables as the late capture.
async function assess(world: RunnerWorld, files: PackageFileSystem = world.cloud.storage): Promise<Assessment> {
  const requests: LateEvidenceRequest[] = [];
  const command = new LateEvidenceAssessCommand({
    files: (): PackageFileSystem => files,
    validator: lifecycleValidator(),
    assess: (request): ReturnType<typeof assessLateEvidenceAmendment> => {
      requests.push(request);
      const capture = { store: world.cloud.store, dlq: world.cloud.dlqReceiver, durable: world.cloud.durable };
      return assessLateEvidenceAmendment(
        request.admitted,
        request.capture ? { files, services: world.services, capture } : { files, services: world.services },
      );
    },
  });
  const argv = [
    'late-evidence',
    'assess',
    packageOperand(world.admitted.identity),
    '--evidence-root',
    STORED_EVIDENCE_ROOT,
  ];
  const run = await world.drive(runCli(argv, [command]));
  return { run, requests };
}

function amendmentIndexPattern(world: RunnerWorld): RegExp {
  return new RegExp(
    `^${PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)}/000\\d-[^/]+/amendment-index\\.json$`,
  );
}

describe('late-evidence assess', () => {
  it('reassesses the packaged stream of a clean run into one amendment (exit 0)', async () => {
    const world = await RunnerWorld.create();
    await world.run();
    const { run, requests } = await assess(world);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.run_id, executionIdOf(world.admitted.identity));
    assert.deepEqual(
      requests.map((request) => [request.capture, request.evidence_root]),
      [[false, STORED_EVIDENCE_ROOT]],
    );
    assert.match(run.result.written_paths[0] ?? '', amendmentIndexPattern(world));
    assert.equal(run.result.result_record?.['record_type'], 'late_evidence_assessment');
    assert.deepEqual(run.stderr_lines, [
      `reassessing ${world.admitted.package_directory} from its packaged late stream`,
    ]);
  });

  it('re-captures over the tables of a leaked execution', async () => {
    const { world } = await leakedExecution();
    const { run, requests } = await assess(world);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.deepEqual(
      requests.map((request) => request.capture),
      [true],
    );
    assert.deepEqual(run.stderr_lines, [
      `reassessing ${world.admitted.package_directory} from a re-capture over its tables`,
    ]);
  });

  it('reads the packaged stream once a whole clean recovery proved the resources gone', async () => {
    const { world } = await recoveredExecution();
    const { run, requests } = await assess(world);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.deepEqual(
      requests.map((request) => request.capture),
      [false],
    );
    assert.match(run.result.written_paths[0] ?? '', /\/0002-[^/]+\/amendment-index\.json$/);
  });

  it('refuses an unfinalized package before asking the service', async () => {
    const world = await RunnerWorld.create();
    const { run, requests } = await assess(world);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['PACKAGE_NOT_FINALIZED'],
    );
    assert.deepEqual(requests, []);
  });

  it('is an evidence failure when the amendments cannot be read, or the amendment written', async () => {
    const world = await RunnerWorld.create();
    await world.run();
    const unlisted = new RefusingPackageStorage();
    await copyEvidence(world, unlisted);
    unlisted.refuseListing(PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity));
    const unreadable = await assess(world, unlisted);
    assert.equal(unreadable.run.exit_code, 10);
    assert.deepEqual(
      unreadable.run.result.reasons.map((reason) => reason.code),
      ['AMENDMENTS_UNREADABLE'],
    );
    assert.deepEqual(unreadable.requests, []);
    const unwritable = new RefusingPackageStorage();
    await copyEvidence(world, unwritable);
    unwritable.refuseWritesUnder(`${PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)}/`);
    const refused = await assess(world, unwritable);
    assert.equal(refused.run.exit_code, 10);
    assert.equal(refused.run.result.reasons[0]?.code, 'AMENDMENT_NOT_WRITTEN');
  });

  it('refuses an operand outside the evidence root as a usage error', async () => {
    const world = await RunnerWorld.create();
    const command = new LateEvidenceAssessCommand({
      files: (): PackageFileSystem => world.cloud.storage,
      validator: lifecycleValidator(),
      assess: (): never => assert.fail('never assessed'),
    });
    const run = await runCli(
      ['late-evidence', 'assess', '/elsewhere/runs/x', '--evidence-root', STORED_EVIDENCE_ROOT],
      [command],
    );
    assert.equal(run.exit_code, 2);
  });
});
