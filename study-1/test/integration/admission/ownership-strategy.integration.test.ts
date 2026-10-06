// Conformance of A12's ownership strategy with the pinned CDK (BR-RUA-046, BR-RUA-050; design
// §9.7, §9.8 S1). A real synthesis of each execution kind writes the stack's ownership tags where
// `ownershipStrategyReasons` reads them (`manifest.json` `artifacts.<stack>.properties.tags`) with
// the values it expects, and a validation's `suc:variant_id` stays on the variant subtree, off the
// stack. The scripted synthesis of the admission harness writes the very same stack tags, so the
// AC-RUA-014 and admitted-execution cases exercise the manifest shape the CDK really produces.
//
// Boundary: the study app synthesized in-process with local esbuild under the Docker sentinel,
// read back through the Node assembly file system and admission's own directory reader. Nothing
// touches AWS.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readAssemblyDirectory } from '../../../src/admission/assembly-files.ts';
import { ASSEMBLY_MANIFEST_FILE, ownershipStrategyReasons } from '../../../src/admission/ownership-strategy.ts';
import { NodeAssemblyFileSystem } from '../../../src/deployment-assembly/node/node-assembly-file-system.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { ExecutionKind, JsonValue } from '../../../src/record-contract/primitives.ts';
import { synthesizedStackTags } from '../../support/admission/synth-templates.ts';
import { synthContext } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { synthesizeExecution } from '../../support/deployment-assembly/study-synth.ts';
import { parsedJson } from '../../support/kernel/deep-json.ts';

const KINDS: readonly ExecutionKind[] = ['RUN', 'TRANSPORT_PROBE', 'VARIANT_VALIDATION'];

function memberAt(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  return path.reduce<JsonValue | undefined>(
    (current, name) => (isJsonObject(current) && Object.hasOwn(current, name) ? current[name] : undefined),
    value,
  );
}

describe('A12 ownership strategy against a real CDK synthesis', () => {
  let work = '';

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'rua-ownership-'));
  });

  after(() => {
    rmSync(work, { recursive: true, force: true });
  });

  for (const kind of KINDS) {
    it(`${kind}: the synthesized stack declares the ownership strategy admission checks`, async () => {
      const context = synthContext(kind, kind === 'VARIANT_VALIDATION' ? 'durable' : undefined);
      const synthesized = synthesizeExecution(context, join(work, kind));
      const directory = await readAssemblyDirectory(new NodeAssemblyFileSystem(), synthesized.assemblyDir);
      assert.ok(directory.ok, JSON.stringify(directory));
      const stack = synthesized.stack.stackName;
      assert.deepEqual(ownershipStrategyReasons(context, directory.value, stack), []);
      const manifest = directory.value.files.find((file) => file.path === ASSEMBLY_MANIFEST_FILE);
      assert.ok(manifest !== undefined);
      const tags = memberAt(parsedJson(new TextDecoder().decode(manifest.bytes)), [
        'artifacts',
        stack,
        'properties',
        'tags',
      ]);
      assert.deepEqual(tags, synthesizedStackTags(context));
    });
  }
});
