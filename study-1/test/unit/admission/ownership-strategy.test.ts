// Step A12's ownership strategy (BR-RUA-046 "missing ownership strategy", BR-RUA-050, D-07): the
// synthesized stack declares each of the five ownership tags with a usable value, `suc:run_id`
// names the execution and `suc:expires_at` is the admission instant plus the total target.
// Everything else is refused with the offending value, bounded, whatever the manifest holds
// (A-05: deep nesting, inherited member names, overflowing numbers).
//
// Boundary: the pure check over an assembly listing built from the scripted synthesis output.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AssemblyDirectory } from '../../../src/admission/assembly-files.ts';
import {
  ASSEMBLY_MANIFEST_FILE,
  STACK_OWNERSHIP_TAG_KEYS,
  ownershipStrategyReasons,
} from '../../../src/admission/ownership-strategy.ts';
import type { JsonObject, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { stackName } from '../../../infra/ownership/resource-naming.ts';
import { ACCOUNT_ID } from '../../support/admission/admission-fixtures.ts';
import { harnessId } from '../../support/admission/admission-harness.ts';
import { synthesizedAssemblyFiles, synthesizedStackTags } from '../../support/admission/synth-templates.ts';
import type { SynthOutputOptions } from '../../support/admission/synth-templates.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';

const EXECUTION_ID: Uuid4 = harnessId(2);
const CONTEXT: ExecutionSynthContext = {
  execution_kind: 'RUN',
  execution_id: EXECUTION_ID,
  account: ACCOUNT_ID,
  region: 'us-east-1',
  admitted_at: '2026-10-06T09:00:04.000Z' as UtcMillis,
  total_target_ms: 5_400_000,
};
const STACK = stackName('RUN', EXECUTION_ID);
const EXPECTED_SHAPE = `expected artifacts."${STACK}".properties.tags declaring suc:project, suc:study_id, suc:run_id, suc:managed_by, suc:expires_at`;
const encoder = new TextEncoder();

function directoryOf(options: SynthOutputOptions = {}): AssemblyDirectory {
  const files = synthesizedAssemblyFiles(CONTEXT, options);
  return { entries: [], files: files.map((file) => ({ ...file })) };
}

function withManifestText(text: string): AssemblyDirectory {
  const directory = directoryOf();
  return {
    entries: [],
    files: directory.files.map((file) =>
      file.path === ASSEMBLY_MANIFEST_FILE ? { ...file, bytes: encoder.encode(text) } : file,
    ),
  };
}

function tagged(members: Readonly<Record<string, unknown>>): AssemblyDirectory {
  return directoryOf({ stack_tags: { ...synthesizedStackTags(CONTEXT), ...members } as JsonObject });
}

function details(directory: AssemblyDirectory, stack: string = STACK): readonly string[] {
  return ownershipStrategyReasons(CONTEXT, directory, stack).map((reason) => `${reason.code} ${reason.detail}`);
}

describe('ownershipStrategyReasons (A12, BR-RUA-046, BR-RUA-050)', () => {
  it('admits a stack that declares the five ownership tags of its execution', () => {
    assert.deepEqual(STACK_OWNERSHIP_TAG_KEYS, [
      'suc:project',
      'suc:study_id',
      'suc:run_id',
      'suc:managed_by',
      'suc:expires_at',
    ]);
    assert.deepEqual(ownershipStrategyReasons(CONTEXT, directoryOf(), STACK), []);
    assert.equal(synthesizedStackTags(CONTEXT)['suc:expires_at'], '2026-10-06T10:30:04.000Z');
  });

  it('refuses a stack that declares no tags, naming what the manifest holds', () => {
    assert.deepEqual(ownershipStrategyReasons(CONTEXT, directoryOf({ stack_tags: 'absent' }), STACK), [
      {
        code: 'OWNERSHIP_STRATEGY_MISSING',
        subject: 'BR-RUA-046',
        detail: `manifest.json declares stack tags absent; ${EXPECTED_SHAPE}`,
      },
    ]);
    assert.deepEqual(details(withManifestText('{"artifacts":{}}')), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json declares stack tags absent; ${EXPECTED_SHAPE}`,
    ]);
    assert.deepEqual(details(withManifestText('[]')), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json declares stack tags absent; ${EXPECTED_SHAPE}`,
    ]);
    assert.deepEqual(details(directoryOf({ stack_tags: ['suc:run_id'] as unknown as JsonObject })), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json declares stack tags array ["suc:run_id"]; ${EXPECTED_SHAPE}`,
    ]);
  });

  it('refuses an assembly without a readable cloud assembly manifest', () => {
    const missing = { entries: [], files: directoryOf().files.filter((file) => file.path !== ASSEMBLY_MANIFEST_FILE) };
    assert.deepEqual(details(missing), [
      `OWNERSHIP_STRATEGY_MISSING the assembly has no manifest.json; ${EXPECTED_SHAPE}`,
    ]);
    assert.deepEqual(details(withManifestText('{"version":')), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json is not JSON (invalid_json); ${EXPECTED_SHAPE}`,
    ]);
    assert.deepEqual(details(withManifestText('{"version":1e400}')), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json is not JSON (invalid_json); ${EXPECTED_SHAPE}`,
    ]);
  });

  it('reads the tags of the synthesized stack only', () => {
    const other = stackName('RUN', '7d2c4b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d' as Uuid4);
    assert.deepEqual(details(directoryOf(), other), [
      `OWNERSHIP_STRATEGY_MISSING manifest.json declares stack tags absent; expected artifacts."${other}".properties.tags declaring suc:project, suc:study_id, suc:run_id, suc:managed_by, suc:expires_at`,
    ]);
  });

  it('reads own members only, so inherited names never stand in for the manifest', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.equal(details(directoryOf(), name)[0]?.startsWith('OWNERSHIP_STRATEGY_MISSING'), true, name);
    }
    const inherited = withManifestText(
      `{"artifacts":{"${STACK}":{"properties":{"tags":{"__proto__":${JSON.stringify(synthesizedStackTags(CONTEXT))}}}}}}`,
    );
    assert.equal(details(inherited).length, 5);
  });

  it('refuses each missing, empty, "@"-bearing or non-string tag, in the spec order', () => {
    assert.deepEqual(
      details(tagged({ 'suc:project': '', 'suc:study_id': 'study@1', 'suc:managed_by': 7, 'suc:run_id': null })),
      [
        'OWNERSHIP_TAG_INVALID stack tag suc:project is string ""; expected a non-empty string without "@"',
        'OWNERSHIP_TAG_INVALID stack tag suc:study_id is string "study@1"; expected a non-empty string without "@"',
        `OWNERSHIP_TAG_INVALID stack tag suc:run_id is null null; expected "${EXECUTION_ID}"`,
        'OWNERSHIP_TAG_INVALID stack tag suc:managed_by is number 7; expected a non-empty string without "@"',
      ],
    );
    const { 'suc:expires_at': _expires, ...withoutExpiry } = synthesizedStackTags(CONTEXT);
    assert.deepEqual(details(directoryOf({ stack_tags: withoutExpiry })), [
      'OWNERSHIP_TAG_INVALID stack tag suc:expires_at is absent; expected "2026-10-06T10:30:04.000Z"',
    ]);
    assert.equal(ownershipStrategyReasons(CONTEXT, tagged({}), STACK)[0], undefined);
  });

  it('D-07: refuses a run id of another execution and an expiry other than admission plus the target', () => {
    assert.deepEqual(details(tagged({ 'suc:run_id': harnessId(3), 'suc:expires_at': '2026-10-06T10:30:05.000Z' })), [
      `OWNERSHIP_TAG_INVALID stack tag suc:run_id is string "${harnessId(3)}"; expected "${EXECUTION_ID}"`,
      'OWNERSHIP_TAG_INVALID stack tag suc:expires_at is string "2026-10-06T10:30:05.000Z"; expected "2026-10-06T10:30:04.000Z"',
    ]);
    assert.deepEqual(
      ownershipStrategyReasons(CONTEXT, tagged({ 'suc:run_id': `${EXECUTION_ID}@x` }), STACK).map(
        (reason) => reason.subject,
      ),
      ['BR-RUA-050'],
    );
  });

  it('A-05: stays total and bounded on towers 100,000 levels deep in the manifest and in a tag', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = towerText(shape, DEEP_NESTING, '1');
      const [stackTags] = details(withManifestText(`{"artifacts":{"${STACK}":{"properties":{"tags":${tower}}}}}`));
      assert.ok(stackTags !== undefined && stackTags.length < 600, shape);
      const [deepTag] = details(
        withManifestText(`{"artifacts":{"${STACK}":{"properties":{"tags":{"suc:project":${tower}}}}}}`),
      );
      assert.ok(deepTag !== undefined && deepTag.length < 600, shape);
      assert.ok(deepTag.startsWith('OWNERSHIP_TAG_INVALID stack tag suc:project is '), shape);
      assert.equal(details(withManifestText(tower))[0]?.startsWith('OWNERSHIP_STRATEGY_MISSING'), true, shape);
    }
  });
});
