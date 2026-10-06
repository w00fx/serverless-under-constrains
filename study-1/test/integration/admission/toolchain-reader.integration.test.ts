// The production toolchain port (design §10.1 A6) over this repository and over an empty study
// root: it reports the running Node, npm, the installed esbuild and CDK CLI, and whether `npm ls`
// finds the tree consistent with the lockfile; a tool that is not installed is absent, and an npm
// that cannot start leaves the dependency tree unconfirmed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assessCapabilities } from '../../../src/admission/capability-check.ts';
import { ToolchainReader } from '../../../src/admission/node/toolchain-reader.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('ToolchainReader', () => {
  it('reads this repository toolchain, which A6 admits', async () => {
    const facts = await new ToolchainReader({ studyRoot: STUDY_ROOT, nodeVersion: process.version }).readToolchain();
    assert.ok(facts.ok);
    assert.equal(facts.value.node_version, process.version);
    assert.match(facts.value.npm_version ?? '', /^\d+\.\d+\.\d+$/);
    assert.match(facts.value.esbuild_version ?? '', /^0\.\d+\.\d+$/);
    assert.match(facts.value.aws_cdk_cli_version ?? '', /^2\.\d+\.\d+$/);
    assert.deepEqual(
      [facts.value.dependency_tree_consistent, facts.value.dependency_tree_detail],
      [true, 'npm ls exited 0'],
    );
    const verdict = assessCapabilities({
      toolchain: facts,
      unreserved_concurrency: { ok: true, value: 1000 },
      bootstrap_status: { ok: true, value: 'UPDATE_COMPLETE' },
      required_concurrency: 4,
    });
    assert.equal(verdict.passed, true, JSON.stringify(verdict));
  });

  it('reports absent tools and an unconfirmed tree in an empty root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-admission-toolchain-'));
    try {
      mkdirSync(join(root, 'node_modules', 'esbuild'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'esbuild', 'package.json'), '{"name":"esbuild",');
      const facts = await new ToolchainReader({
        studyRoot: root,
        nodeVersion: 'v24.15.0',
        npmExecutable: join(root, 'missing-npm'),
      }).readToolchain();
      assert.ok(facts.ok);
      assert.equal(facts.value.npm_version, undefined);
      assert.equal(facts.value.esbuild_version, undefined, 'an unreadable manifest reads as not installed');
      assert.equal(facts.value.aws_cdk_cli_version, undefined);
      assert.equal(facts.value.dependency_tree_consistent, false);
      assert.match(facts.value.dependency_tree_detail, /^npm ls exited 127: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
