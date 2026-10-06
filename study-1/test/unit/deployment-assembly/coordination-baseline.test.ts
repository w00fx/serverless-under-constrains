// The coordination baseline deployment behind `rua coordination bootstrap` (design §9.1, §11;
// BR-RUA-045): a credential-free `cdk synth` of `infra/bin/coordination-app.ts`, then `cdk deploy`
// of that assembly with the operator's credentials and no approval prompt, both through the
// CommandRunner, ending in a DeployReport; every failure is a report with its reason.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COORDINATION_STACK_NAME } from '../../../infra/stacks/coordination-stack.ts';
import {
  COORDINATION_APP_ENTRY,
  COORDINATION_STACK,
  CoordinationBaselineDeployer,
  coordinationDeployInvocation,
  coordinationSynthInvocation,
} from '../../../src/deployment-assembly/coordination-baseline.ts';
import type { CdkToolSettings } from '../../../src/deployment-assembly/cdk-invocations.ts';
import { MEMORY_TOOLS, SteppingWallClock } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FakeCommandRunner } from '../../support/deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const WORK_DIR = '/study/.coordination-staging/attempt-1';
const OUTPUTS = `{"${COORDINATION_STACK}":{"CoordinationTableArn":"arn:aws:dynamodb:us-east-1:123456789012:table/suc-study-1-coordination"}}`;

interface CoordinationRig {
  readonly files: MemoryAssemblyFileSystem;
  readonly runner: FakeCommandRunner;
  readonly deployer: CoordinationBaselineDeployer;
}

function rig(tools: CdkToolSettings = MEMORY_TOOLS): CoordinationRig {
  const files = new MemoryAssemblyFileSystem();
  const runner = new FakeCommandRunner(files);
  runner.scriptDeployOutputs(OUTPUTS);
  return {
    files,
    runner,
    deployer: new CoordinationBaselineDeployer({ runner, files, tools, clock: new SteppingWallClock() }),
  };
}

function reasonCodes(report: {
  readonly reasons: readonly { readonly code: string; readonly subject: string }[];
}): readonly string[][] {
  return report.reasons.map((reason) => [reason.code, reason.subject]);
}

describe('coordination baseline invocations', () => {
  it('names the stack and the app infra defines', () => {
    assert.equal(COORDINATION_STACK, COORDINATION_STACK_NAME);
    assert.ok(existsSync(fileURLToPath(new URL(`../../../${COORDINATION_APP_ENTRY}`, import.meta.url))));
  });

  it('synthesizes the coordination app without any AWS identity', () => {
    const synth = coordinationSynthInvocation(MEMORY_TOOLS, WORK_DIR);
    assert.ok(synth.ok);
    assert.equal(synth.value.executable, MEMORY_TOOLS.node_executable);
    assert.deepEqual(synth.value.args, [
      MEMORY_TOOLS.cdk_cli_entry,
      'synth',
      COORDINATION_STACK,
      '--app',
      `"${MEMORY_TOOLS.node_executable}" infra/bin/coordination-app.ts`,
      '--output',
      `${WORK_DIR}/cdk.out`,
      '--no-lookups',
      '--no-version-reporting',
      '--no-notices',
      '--quiet',
    ]);
    assert.equal(synth.value.cwd, MEMORY_TOOLS.study_root);
    assert.ok(
      !Object.keys(synth.value.env).some(
        (key) =>
          key.startsWith('AWS_') && !/^AWS_(EC2_METADATA_DISABLED|CONFIG_FILE|SHARED_CREDENTIALS_FILE)$/.test(key),
      ),
    );
    assert.equal(synth.value.env['AWS_EC2_METADATA_DISABLED'], 'true');
    assert.equal(synth.value.env['AWS_SHARED_CREDENTIALS_FILE'], `${WORK_DIR}/no-aws-config`);
    assert.equal(synth.value.env['CDK_DOCKER'], MEMORY_TOOLS.docker_sentinel);
  });

  it('refuses a Node path the --app command cannot quote', () => {
    const synth = coordinationSynthInvocation({ ...MEMORY_TOOLS, node_executable: '/opt/$node' }, WORK_DIR);
    assert.equal(synth.ok ? undefined : synth.error.code, 'UNQUOTABLE_NODE_PATH');
  });

  it('deploys the synthesized assembly with the operator credentials and no approval prompt', () => {
    const deploy = coordinationDeployInvocation(MEMORY_TOOLS, WORK_DIR);
    assert.deepEqual(deploy.args, [
      MEMORY_TOOLS.cdk_cli_entry,
      'deploy',
      COORDINATION_STACK,
      '--app',
      `${WORK_DIR}/cdk.out`,
      '--exclusively',
      '--require-approval',
      'never',
      '--outputs-file',
      `${WORK_DIR}/outputs.json`,
      '--no-version-reporting',
      '--no-notices',
    ]);
    assert.equal(deploy.env['AWS_PROFILE'], 'operator');
    assert.equal(deploy.env['AWS_ACCESS_KEY_ID'], 'AKIAEXAMPLE');
  });
});

describe('CoordinationBaselineDeployer', () => {
  it('synthesizes then deploys, and reports the outputs', async () => {
    const { runner, deployer } = rig();
    const report = await deployer.deploy(WORK_DIR);
    assert.deepEqual(report, {
      stack_name: COORDINATION_STACK,
      deployed: true,
      started_at: '2026-10-05T12:00:00.000Z',
      completed_at: '2026-10-05T12:00:01.000Z',
      outputs: [
        {
          key: 'CoordinationTableArn',
          value: 'arn:aws:dynamodb:us-east-1:123456789012:table/suc-study-1-coordination',
        },
      ],
      reasons: [],
    });
    assert.deepEqual(
      runner.invocations().map((invocation) => invocation.args[1]),
      ['synth', 'deploy'],
    );
  });

  it('refuses a work directory that holds files or cannot be listed, running nothing', async () => {
    const occupied = rig();
    await occupied.files.createFile(`${WORK_DIR}/stale.json`, new Uint8Array([1]), 0o644);
    const report = await occupied.deployer.deploy(WORK_DIR);
    assert.deepEqual(reasonCodes(report), [['COORDINATION_WORK_DIR_UNUSABLE', 'BR-RUA-045']]);
    assert.match(report.reasons[0]?.detail ?? '', /holds 1 entries; expected an absent or empty work directory$/);
    assert.deepEqual(occupied.runner.invocations(), []);

    const unreadable = rig();
    unreadable.files.failList(WORK_DIR);
    const refused = await unreadable.deployer.deploy(WORK_DIR);
    assert.deepEqual(reasonCodes(refused), [['COORDINATION_WORK_DIR_UNUSABLE', 'BR-RUA-045']]);
    assert.match(refused.reasons[0]?.detail ?? '', /holds IO_ERROR: /);
  });

  it('accepts an existing empty work directory', async () => {
    const { files, deployer } = rig();
    await files.createFile(`${WORK_DIR}/x`, new Uint8Array([1]), 0o644);
    await files.removeFile(`${WORK_DIR}/x`);
    assert.equal((await deployer.deploy(WORK_DIR)).deployed, true);
  });

  it('reports an unquotable Node path without running anything', async () => {
    const { runner, deployer } = rig({ ...MEMORY_TOOLS, node_executable: '/opt/"node' });
    const report = await deployer.deploy(WORK_DIR);
    assert.deepEqual(reasonCodes(report), [['UNQUOTABLE_NODE_PATH', 'BR-RUA-045']]);
    assert.deepEqual(runner.invocations(), []);
  });

  it('never deploys after a failed synthesis', async () => {
    const { runner, deployer } = rig();
    runner.enqueue({ kind: 'exited', exit_code: 1, stdout: '', stderr: 'CDK_DEFAULT_ACCOUNT "x"' });
    const report = await deployer.deploy(WORK_DIR);
    assert.deepEqual(reasonCodes(report), [['COORDINATION_SYNTH_FAILED', 'BR-RUA-045']]);
    assert.match(
      report.reasons[0]?.detail ?? '',
      /^cdk synth suc-study-1-coordination exited with status 1; stderr tail: CDK_DEFAULT_ACCOUNT "x"; expected exit status 0$/,
    );
    assert.equal(runner.invocations().length, 1);
    assert.equal(report.deployed, false);
    assert.deepEqual(report.outputs, []);
  });

  it('reports a failed deployment', async () => {
    const { runner, deployer } = rig();
    runner.enqueue({ kind: 'exited', exit_code: 0, stdout: '', stderr: '' });
    runner.enqueue({ kind: 'signalled', signal: 'SIGTERM', stdout: '', stderr: '' });
    const report = await deployer.deploy(WORK_DIR);
    assert.deepEqual(reasonCodes(report), [['COORDINATION_DEPLOY_FAILED', 'BR-RUA-045']]);
  });

  it('reports a missing or malformed outputs file', async () => {
    const missing = rig();
    missing.runner.scriptDeployOutputs(new Uint8Array(0));
    missing.files.failRead(`${WORK_DIR}/outputs.json`);
    assert.deepEqual(reasonCodes(await missing.deployer.deploy(WORK_DIR)), [
      ['COORDINATION_OUTPUTS_UNREADABLE', 'BR-RUA-045'],
    ]);

    const malformed = rig();
    malformed.runner.scriptDeployOutputs('{"other-stack":{}}');
    assert.deepEqual(reasonCodes(await malformed.deployer.deploy(WORK_DIR)), [['OUTPUTS_UNREADABLE', 'BR-RUA-045']]);
  });
});
