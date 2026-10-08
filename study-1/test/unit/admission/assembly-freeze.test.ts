// Step A12 (BR-RUA-042, D-25): one synthesis, then the assembly as admission reads it is
// inventoried, its template parsed and its ownership strategy checked (BR-RUA-046, BR-RUA-050).
// The synthesizer and admission's reader are separate ports, so a template the synthesizer
// reported but admission cannot find is refused, not assumed.
//
// Boundary: the production `CdkAssemblySynthesizer` over the scripted CDK CLI writes into one
// memory file system; admission reads either that one or a second memory file system.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FROZEN_ASSEMBLY_PATH, synthesizeAssembly } from '../../../src/admission/assembly-freeze.ts';
import { CdkAssemblySynthesizer } from '../../../src/deployment-assembly/cdk-assembly-synthesizer.ts';
import { SYNTH_OUTPUT_DIR } from '../../../src/deployment-assembly/cdk-invocations.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { stackName } from '../../../infra/ownership/resource-naming.ts';
import { ACCOUNT_ID } from '../../support/admission/admission-fixtures.ts';
import { harnessId } from '../../support/admission/admission-harness.ts';
import { synthesizedAssemblyFiles } from '../../support/admission/synth-templates.ts';
import type { SynthOutputOptions } from '../../support/admission/synth-templates.ts';
import { MEMORY_TOOLS } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FakeCommandRunner } from '../../support/deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const EXECUTION_ID = harnessId(2);
const AT = '2026-10-06T09:00:00.000Z' as UtcMillis;
const STAGING = '/staging/attempt';
const CONTEXT: ExecutionSynthContext = {
  execution_kind: 'TRANSPORT_PROBE',
  execution_id: EXECUTION_ID,
  account: ACCOUNT_ID,
  region: 'us-east-1',
  admitted_at: AT,
  total_target_ms: 600_000,
};
const TEMPLATE_FILE = `${stackName('TRANSPORT_PROBE', EXECUTION_ID)}.template.json`;

function synthesizerOver(files: MemoryAssemblyFileSystem, options: SynthOutputOptions = {}): CdkAssemblySynthesizer {
  const runner = new FakeCommandRunner(files);
  runner.scriptSynthOutput(synthesizedAssemblyFiles(CONTEXT, options));
  return new CdkAssemblySynthesizer({ runner, files, tools: MEMORY_TOOLS });
}

describe('synthesizeAssembly (A12)', () => {
  it('inventories the synthesized assembly at the frozen path and parses its template', async () => {
    const files = new MemoryAssemblyFileSystem();
    const verdict = await synthesizeAssembly(CONTEXT, STAGING, { synthesizer: synthesizerOver(files), files }, AT);
    assert.ok(verdict.passed);
    assert.equal(verdict.value.inventory.assembly_path, FROZEN_ASSEMBLY_PATH);
    assert.equal(verdict.value.template_path, `${FROZEN_ASSEMBLY_PATH}/${TEMPLATE_FILE}`);
    assert.equal(verdict.value.synth.assembly_dir, `${STAGING}/${SYNTH_OUTPUT_DIR}`);
    assert.deepEqual(verdict.statement.observed, {
      inventory_sha256: verdict.value.inventory.inventory_sha256,
      files: verdict.value.inventory.files.length,
    });
  });

  it('refuses a template that admission cannot find where the synthesizer reported it', async () => {
    const synthesized = new MemoryAssemblyFileSystem();
    const reader = new MemoryAssemblyFileSystem();
    for (const file of synthesizedAssemblyFiles(CONTEXT)) {
      if (file.path !== TEMPLATE_FILE) {
        await reader.createFile(`${STAGING}/${SYNTH_OUTPUT_DIR}/${file.path}`, file.bytes, file.mode);
      }
    }
    const verdict = await synthesizeAssembly(
      CONTEXT,
      STAGING,
      { synthesizer: synthesizerOver(synthesized), files: reader },
      AT,
    );
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'SAFETY');
    assert.deepEqual(verdict.reasons, [
      {
        code: 'TEMPLATE_UNREADABLE',
        subject: 'BR-RUA-042',
        detail: `template string "${TEMPLATE_FILE}" is absent; expected the synthesized stack template`,
      },
    ]);
  });

  it('BR-RUA-046: refuses a stack without the ownership strategy, after reading its template', async () => {
    const files = new MemoryAssemblyFileSystem();
    const synthesizer = synthesizerOver(files, { stack_tags: 'absent' });
    const verdict = await synthesizeAssembly(CONTEXT, STAGING, { synthesizer, files }, AT);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'SAFETY');
    assert.deepEqual(verdict.statement.expected, {
      boundary: 'OWNERSHIP_STRATEGY',
      assembly_path: FROZEN_ASSEMBLY_PATH,
    });
    assert.deepEqual(
      verdict.reasons.map((reason) => [reason.code, reason.subject]),
      [['OWNERSHIP_STRATEGY_MISSING', 'BR-RUA-046']],
    );
  });

  it('reports every invalid ownership tag at once', async () => {
    const files = new MemoryAssemblyFileSystem();
    const synthesizer = synthesizerOver(files, { stack_tags: { 'suc:project': 'serverless-under-constraints' } });
    const verdict = await synthesizeAssembly(CONTEXT, STAGING, { synthesizer, files }, AT);
    assert.ok(!verdict.passed);
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.detail.slice(0, reason.detail.indexOf(' is '))),
      ['stack tag suc:study_id', 'stack tag suc:run_id', 'stack tag suc:managed_by', 'stack tag suc:expires_at'],
    );
  });
});
