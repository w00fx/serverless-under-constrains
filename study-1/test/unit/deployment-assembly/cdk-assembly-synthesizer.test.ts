// The production AssemblySynthesizer over a scripted CLI (design §9.8 S1, §10.1 A12; BR-RUA-042):
// it writes the context file, runs `cdk synth` exactly once, and accepts the assembly only when the
// template and manifest are regular files and no CLI lock file remains. Every failure is one
// structured reason and nothing is retried.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CdkAssemblySynthesizer,
  CLOUD_ASSEMBLY_MANIFEST,
} from '../../../src/deployment-assembly/cdk-assembly-synthesizer.ts';
import type { CommandResult } from '../../../src/deployment-assembly/command-runner.ts';
import { MEMORY_TOOLS, RUN_STACK, synthContext } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FakeCommandRunner } from '../../support/deployment-assembly/fake-command-runner.ts';
import type { ScriptedAssemblyFile } from '../../support/deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const STAGING = '/attempt/staging';
const encoder = new TextEncoder();
const TEMPLATE_FILE = `${RUN_STACK}.template.json`;

function assemblyFile(path: string): ScriptedAssemblyFile {
  return { path, bytes: encoder.encode('{}'), mode: 0o644 };
}

interface SynthRig {
  readonly files: MemoryAssemblyFileSystem;
  readonly runner: FakeCommandRunner;
  readonly synthesizer: CdkAssemblySynthesizer;
}

function rig(
  output: readonly ScriptedAssemblyFile[] = [assemblyFile(CLOUD_ASSEMBLY_MANIFEST), assemblyFile(TEMPLATE_FILE)],
): SynthRig {
  const files = new MemoryAssemblyFileSystem();
  const runner = new FakeCommandRunner(files);
  runner.scriptSynthOutput(output);
  return { files, runner, synthesizer: new CdkAssemblySynthesizer({ runner, files, tools: MEMORY_TOOLS }) };
}

describe('CdkAssemblySynthesizer', () => {
  it('writes the context, runs cdk synth once and reports the assembly', async () => {
    const { files, runner, synthesizer } = rig();
    const context = synthContext('RUN');
    const report = await synthesizer.synthesize(context, STAGING);
    assert.deepEqual(report, {
      ok: true,
      value: {
        assembly_dir: `${STAGING}/cdk.out`,
        stack_name: RUN_STACK,
        template_file: TEMPLATE_FILE,
        context_file: `${STAGING}/execution-context.json`,
      },
    });
    const written = await files.read(`${STAGING}/execution-context.json`);
    assert.equal(written.ok ? new TextDecoder().decode(written.value) : '', `${JSON.stringify(context)}\n`);
    const listed = await files.list(STAGING);
    assert.equal(listed.ok ? listed.value.find((entry) => entry.path === 'execution-context.json')?.mode : 0, 0o100644);
    assert.equal(runner.invocations().length, 1);
    assert.deepEqual(runner.invocations()[0]?.args.slice(1, 3), ['synth', RUN_STACK]);
  });

  it('names the stack of the execution kind', async () => {
    const { synthesizer } = rig([
      assemblyFile(CLOUD_ASSEMBLY_MANIFEST),
      assemblyFile('SucRua-probe-3f1c2a9e.template.json'),
    ]);
    const report = await synthesizer.synthesize(synthContext('TRANSPORT_PROBE'), STAGING);
    assert.equal(report.ok ? report.value.stack_name : '', 'SucRua-probe-3f1c2a9e');
  });

  it('refuses an unquotable Node path before writing or running anything', async () => {
    const files = new MemoryAssemblyFileSystem();
    const runner = new FakeCommandRunner(files);
    const synthesizer = new CdkAssemblySynthesizer({
      runner,
      files,
      tools: { ...MEMORY_TOOLS, node_executable: '/$x/node' },
    });
    const report = await synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(report.ok ? 'ok' : report.error.code, 'UNQUOTABLE_NODE_PATH');
    assert.deepEqual([runner.invocations().length, (await files.list(STAGING)).ok], [0, false]);
  });

  it('reports a context file it cannot write and runs nothing', async () => {
    const { files, runner, synthesizer } = rig();
    files.failCreate(`${STAGING}/execution-context.json`);
    const report = await synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(report.ok ? 'ok' : report.error.code, 'SYNTH_CONTEXT_NOT_WRITTEN');
    assert.match(report.ok ? '' : report.error.detail, /^IO_ERROR: scripted create failure/);
    assert.equal(runner.invocations().length, 0);
  });

  it('reports a synthesis that does not exit 0, without retrying it', async () => {
    const endings: readonly CommandResult[] = [
      { kind: 'exited', exit_code: 1, stdout: '', stderr: 'Error: docker-forbidden' },
      { kind: 'signalled', signal: 'SIGKILL', stdout: '', stderr: '' },
      { kind: 'spawn_failed', detail: 'ENOENT' },
    ];
    for (const ending of endings) {
      const { runner, synthesizer } = rig();
      runner.enqueue(ending);
      const report = await synthesizer.synthesize(synthContext('RUN'), STAGING);
      assert.equal(report.ok ? 'ok' : report.error.code, 'SYNTH_FAILED');
      assert.equal(report.ok ? '' : report.error.subject, 'BR-RUA-042');
      assert.equal(runner.invocations().length, 1);
    }
    const { runner, synthesizer } = rig();
    runner.enqueue(endings[0] ?? { kind: 'spawn_failed', detail: '' });
    const report = await synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(
      report.ok ? '' : report.error.detail,
      'cdk synth exited with status 1; stderr tail: Error: docker-forbidden; expected exit status 0',
    );
  });

  it('reports an assembly directory that is missing or unreadable', async () => {
    const missing = rig([]);
    const report = await missing.synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(report.ok ? 'ok' : report.error.code, 'SYNTH_OUTPUT_MISSING');
    assert.match(report.ok ? '' : report.error.detail, /^NOT_FOUND: /);
    const unreadable = rig();
    unreadable.files.failList(`${STAGING}/cdk.out`);
    const second = await unreadable.synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.match(second.ok ? '' : second.error.detail, /^IO_ERROR: /);
  });

  it('requires the stack template and the manifest as regular files', async () => {
    const noTemplate = rig([assemblyFile(CLOUD_ASSEMBLY_MANIFEST), assemblyFile('Other.template.json')]);
    const report = await noTemplate.synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(report.ok ? 'ok' : report.error.code, 'SYNTH_OUTPUT_MISSING');
    assert.match(report.ok ? '' : report.error.detail, /^the assembly lacks \["SucRua-run-3f1c2a9e\.template\.json"\]/);
    const linked = rig([assemblyFile(TEMPLATE_FILE)]);
    linked.files.placeSpecial(`${STAGING}/cdk.out/${CLOUD_ASSEMBLY_MANIFEST}`, 'symlink');
    const second = await linked.synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.match(second.ok ? '' : second.error.detail, /^the assembly lacks \["manifest\.json"\]/);
  });

  it('refuses an assembly that still holds a CLI lock file (RF V1)', async () => {
    const locked = rig([
      assemblyFile(CLOUD_ASSEMBLY_MANIFEST),
      assemblyFile(TEMPLATE_FILE),
      assemblyFile('synth.lock'),
      assemblyFile('read.7.1.lock'),
    ]);
    const report = await locked.synthesizer.synthesize(synthContext('RUN'), STAGING);
    assert.equal(report.ok ? 'ok' : report.error.code, 'SYNTH_LOCK_FILE_LEFT');
    assert.match(report.ok ? '' : report.error.detail, /\["read\.7\.1\.lock","synth\.lock"\]/);
  });
});
