// The production AssemblyDeployer over a scripted CLI (design §9.8 D2; D-25; BR-RUA-040): one
// `cdk deploy` of the verified copy, the outputs read for the deployed stack, start and end times on
// the injected clock, and a report with `deployed: false` and its reason for every failure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VerifiedDeployCopy } from '../../../src/deployment-assembly/assembly-ports.ts';
import { CdkAssemblyDeployer } from '../../../src/deployment-assembly/cdk-assembly-deployer.ts';
import type { CommandResult } from '../../../src/deployment-assembly/command-runner.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { MEMORY_TOOLS, RUN_STACK, SteppingWallClock } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FakeCommandRunner } from '../../support/deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const COPY = { dir: '/study/.deploy-staging/x', inventory_sha256: 'a'.repeat(64) as Sha256Hex } as VerifiedDeployCopy;
const OUTPUTS_FILE = '/work/deploy/outputs.json';

interface DeployRig {
  readonly files: MemoryAssemblyFileSystem;
  readonly runner: FakeCommandRunner;
  readonly deployer: CdkAssemblyDeployer;
}

function rig(): DeployRig {
  const files = new MemoryAssemblyFileSystem();
  const runner = new FakeCommandRunner(files);
  return {
    files,
    runner,
    deployer: new CdkAssemblyDeployer({ runner, files, tools: MEMORY_TOOLS, clock: new SteppingWallClock() }),
  };
}

describe('CdkAssemblyDeployer', () => {
  it('deploys the copy and reports the outputs of the deployed stack', async () => {
    const { runner, deployer } = rig();
    runner.scriptDeployOutputs(`{"${RUN_STACK}":{"ProviderVersion":"7","DurableCallerAliasArn":"arn:x"}}`);
    const report = await deployer.deploy(COPY, RUN_STACK, OUTPUTS_FILE);
    assert.deepEqual(report, {
      stack_name: RUN_STACK,
      deployed: true,
      started_at: '2026-10-05T12:00:00.000Z',
      completed_at: '2026-10-05T12:00:01.000Z',
      outputs: [
        { key: 'DurableCallerAliasArn', value: 'arn:x' },
        { key: 'ProviderVersion', value: '7' },
      ],
      reasons: [],
    });
    assert.deepEqual(runner.invocations()[0]?.args.slice(1, 5), ['deploy', RUN_STACK, '--app', COPY.dir]);
    assert.equal(runner.invocations().length, 1);
  });

  it('reports a deployment that does not exit 0 as not deployed', async () => {
    const endings: readonly CommandResult[] = [
      { kind: 'exited', exit_code: 1, stdout: '', stderr: 'ROLLBACK_COMPLETE' },
      { kind: 'signalled', signal: 'SIGTERM', stdout: '', stderr: '' },
      { kind: 'spawn_failed', detail: 'ENOENT' },
    ];
    for (const ending of endings) {
      const { runner, deployer } = rig();
      runner.scriptDeployOutputs(`{"${RUN_STACK}":{}}`);
      runner.enqueue(ending);
      const report = await deployer.deploy(COPY, RUN_STACK, OUTPUTS_FILE);
      assert.deepEqual(
        [report.deployed, report.outputs, report.reasons.map((reason) => [reason.code, reason.subject])],
        [false, [], [['DEPLOY_COMMAND_FAILED', 'BR-RUA-040']]],
      );
      assert.deepEqual(
        [report.started_at, report.completed_at],
        ['2026-10-05T12:00:00.000Z', '2026-10-05T12:00:01.000Z'],
      );
    }
    const { runner, deployer } = rig();
    runner.enqueue(endings[0] ?? { kind: 'spawn_failed', detail: '' });
    const report = await deployer.deploy(COPY, RUN_STACK, OUTPUTS_FILE);
    assert.equal(
      report.reasons[0]?.detail,
      `cdk deploy ${RUN_STACK} exited with status 1; stderr tail: ROLLBACK_COMPLETE; expected exit status 0`,
    );
  });

  it('reports an outputs file the CLI did not write', async () => {
    const { deployer } = rig();
    const report = await deployer.deploy(COPY, RUN_STACK, OUTPUTS_FILE);
    assert.equal(report.deployed, false);
    const [reason] = report.reasons;
    assert.ok(reason !== undefined);
    assert.equal(reason.code, 'OUTPUTS_UNREADABLE');
    assert.match(reason.detail, /^NOT_FOUND: .*; expected the outputs file cdk deploy writes$/);
  });

  it('reports an outputs file of another stack', async () => {
    const { runner, deployer } = rig();
    runner.scriptDeployOutputs('{"SucRua-run-00000000":{}}');
    const report = await deployer.deploy(COPY, RUN_STACK, OUTPUTS_FILE);
    assert.deepEqual([report.deployed, report.reasons.map((reason) => reason.code)], [false, ['OUTPUTS_UNREADABLE']]);
  });
});
