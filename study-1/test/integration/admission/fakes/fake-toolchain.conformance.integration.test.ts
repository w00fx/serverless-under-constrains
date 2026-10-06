// FakeToolchain conformance (design §12.2): its default facts have exactly the members the
// production `ToolchainReader` reports for an installed toolchain, and A6 concludes the same
// for both.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assessCapabilities } from '../../../../src/admission/capability-check.ts';
import type { ToolchainFacts } from '../../../../src/admission/admission-ports.ts';
import { ToolchainReader } from '../../../../src/admission/node/toolchain-reader.ts';
import type { Result } from '../../../../src/record-contract/primitives.ts';
import type { PortFailure } from '../../../../src/admission/admission-ports.ts';
import { FakeToolchain } from '../../../support/admission/fake-toolchain.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function concludes(toolchain: Result<ToolchainFacts, PortFailure>): boolean {
  return assessCapabilities({
    toolchain,
    unreserved_concurrency: { ok: true, value: 1000 },
    bootstrap_status: { ok: true, value: 'CREATE_COMPLETE' },
    required_concurrency: 4,
  }).passed;
}

describe('FakeToolchain conforms to ToolchainReader', () => {
  it('reports the same members and the same A6 conclusion', async () => {
    const real = await new ToolchainReader({ studyRoot: STUDY_ROOT, nodeVersion: process.version }).readToolchain();
    const scripted = await new FakeToolchain().readToolchain();
    assert.ok(real.ok && scripted.ok);
    assert.deepEqual(Object.keys(scripted.value).sort(), Object.keys(real.value).sort());
    assert.equal(concludes(scripted), concludes(real));
  });

  it('reports an inconsistent tree the way A6 refuses it', async () => {
    const scripted = await new FakeToolchain({
      dependency_tree_consistent: false,
      dependency_tree_detail: 'npm ls exited 1: missing: esbuild@0.25.10',
    }).readToolchain();
    assert.equal(concludes(scripted), false);
  });
});
