// Design §12.5 row 13 (BR-RUA-043, BR-RUA-044, AC-RUA-022): `verifyPackage` is never `eligible` with
// any mutated byte of the package or its amendments, and the amendment graph accepts exactly the
// linear, dense, digest-valid chains selected at their head. The graph oracle below is written from
// the rule text, independently of amendment-chain.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { resolveAmendmentGraph } from '../../../src/evidence-package/amendment-chain.ts';
import type { ParsedAmendment } from '../../../src/evidence-package/amendment-chain.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { ExecutionIdentity, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { RUN_ID, at, digest, uuid } from '../../support/record-contract/record-builders.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIXTURE_DEPS,
  amendmentChain,
  billingPayload,
  lateEvidencePayload,
  probePackage,
  verificationInput,
} from '../../support/evidence-package/probe-package-fixtures.ts';

const FIXTURE = probePackage();
const CHAIN = amendmentChain(FIXTURE, [
  { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(FIXTURE, 'consistent')] },
  { kind: 'BILLING', payload: [billingPayload()] },
]);
const HEAD = CHAIN.at(-1)?.index_sha256 ?? null;
/** Every stored file: [-1, i] is file i of the original package, [a, i] file i of amendment a. */
const TARGETS: readonly (readonly [number, number])[] = [
  ...FIXTURE.files.map((_, file) => [-1, file] as const),
  ...CHAIN.flatMap((amendment, position) => amendment.snapshot.files.map((_, file) => [position, file] as const)),
].filter(([owner, file]) => fileOf(owner, file).bytes.length > 0);

function fileOf(owner: number, index: number): PackageFile {
  const files = owner === -1 ? FIXTURE.files : (CHAIN[owner]?.snapshot.files ?? []);
  return files[index] ?? { path: 'absent', bytes: new Uint8Array() };
}

function mutated(files: readonly PackageFile[], index: number, offset: number, mask: number): readonly PackageFile[] {
  return files.map((file, position) => {
    if (position !== index) {
      return file;
    }
    const bytes = file.bytes.slice();
    bytes[offset % bytes.length] = (bytes[offset % bytes.length] ?? 0) ^ mask;
    return { path: file.path, bytes };
  });
}

describe('verifyPackage never accepts a mutated byte (property)', () => {
  it('the fixture itself is eligible', () => {
    assert.equal(verifyPackage(verificationInput(FIXTURE, CHAIN, HEAD), FIXTURE_DEPS).package_eligibility, 'eligible');
  });

  it('flipping any bits of any stored byte makes the package ineligible', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TARGETS),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        ([owner, index], offset, mask) => {
          const original = owner === -1 ? mutated(FIXTURE.files, index, offset, mask) : FIXTURE.files;
          const amendments = CHAIN.map((amendment, position) =>
            position === owner
              ? {
                  ...amendment,
                  snapshot: { ...amendment.snapshot, files: mutated(amendment.snapshot.files, index, offset, mask) },
                }
              : amendment,
          );
          const input = {
            ...verificationInput(FIXTURE, amendments, HEAD),
            original: { files: original, special_entries: [] },
          };
          assert.equal(verifyPackage(input, FIXTURE_DEPS).package_eligibility, 'ineligible');
        },
      ),
      fuzzParameters(),
    );
  });
});

const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
const ORIGINAL = digest('original');
const MANIFEST = digest('manifest');

interface NodeSpec {
  readonly sequence: number;
  /** null, the position of another node, or -1 for a digest no node has. */
  readonly parent: number | null;
}

function graphOf(nodes: readonly NodeSpec[]): readonly ParsedAmendment[] {
  return nodes.map((node, position) => ({
    location: `amendments/${String(position)}/`,
    index_sha256: digest(`node-${String(position)}`),
    files: [],
    index: {
      schema_version: 1,
      record_type: 'amendment_index',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST,
      amendment_id: uuid(0xc00 + position),
      amendment_kind: 'BILLING',
      sequence: node.sequence,
      original_package_index_sha256: ORIGINAL,
      parent_amendment_index_sha256:
        node.parent === null ? null : node.parent === -1 ? digest('dangling') : digest(`node-${String(node.parent)}`),
      entries: [],
      created_at: at(position),
    },
  }));
}

// The rule (BR-RUA-043, design §8.16 step 6): with no amendment, only no head is acceptable; else
// sequences are exactly 1..n, sequence 1 has no parent, sequence k names sequence k-1, and the
// head is the amendment of sequence n.
function isCompleteSelectedChain(nodes: readonly NodeSpec[], head: number | null): boolean {
  if (nodes.length === 0) {
    return head === null;
  }
  const bySequence = new Map(nodes.map((node, position) => [node.sequence, position]));
  const dense =
    bySequence.size === nodes.length && nodes.every((node) => node.sequence >= 1 && node.sequence <= nodes.length);
  const linked = nodes.every((node) =>
    node.sequence === 1 ? node.parent === null : node.parent === bySequence.get(node.sequence - 1),
  );
  return dense && linked && head === bySequence.get(nodes.length);
}

describe('resolveAmendmentGraph accepts only complete linear chains (property)', () => {
  it('reports no reason exactly for a dense, linked chain selected at its head', () => {
    const graphs = fc.integer({ min: 0, max: 5 }).chain((size) =>
      fc.record({
        nodes: fc.array(
          fc.record({
            sequence: fc.integer({ min: 1, max: 6 }),
            parent: fc.option(fc.integer({ min: -1, max: Math.max(size - 1, 0) }), { nil: null }),
          }),
          { minLength: size, maxLength: size },
        ),
        head: fc.option(fc.integer({ min: -1, max: Math.max(size - 1, 0) }), { nil: null }),
      }),
    );
    // Half the cases are built valid, so both sides of the equivalence are exercised.
    const valid = fc.integer({ min: 1, max: 5 }).map((size) => ({
      nodes: Array.from({ length: size }, (_, position): NodeSpec => ({
        sequence: position + 1,
        parent: position === 0 ? null : position - 1,
      })),
      head: size - 1,
    }));
    fc.assert(
      fc.property(fc.oneof(graphs, valid), ({ nodes, head }) => {
        const amendments = graphOf(nodes);
        const selected: Sha256Hex | null =
          head === null ? null : head === -1 ? digest('unknown-head') : digest(`node-${String(head)}`);
        const resolved = resolveAmendmentGraph({
          identity: RUN,
          execution_manifest_sha256: MANIFEST,
          original_package_index_sha256: ORIGINAL,
          amendments,
          selected_head: selected,
        });
        const knownHead = head === null || head === -1 || head < nodes.length ? head : -1;
        assert.equal(
          resolved.reasons.length === 0,
          isCompleteSelectedChain(nodes, knownHead),
          JSON.stringify({ nodes, head, reasons: resolved.reasons.map((r) => r.code) }),
        );
        assert.equal(resolved.known_descendants.length, nodes.length);
      }),
      fuzzParameters(),
    );
  });
});
