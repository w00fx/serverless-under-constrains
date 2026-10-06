// The amendment graph (design §8.16 step 6; BR-RUA-043) on synthetic parsed amendments, where any
// digest can be chosen: membership and parents (`BROKEN_PARENT`), density (`SEQUENCE_GAP`),
// cycles (`CYCLE`), the selected head (`UNKNOWN_HEAD`) and unselected amendments.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { amendmentLink, resolveAmendmentGraph } from '../../../src/evidence-package/amendment-chain.ts';
import type { AmendmentGraphInput, ParsedAmendment } from '../../../src/evidence-package/amendment-chain.ts';
import { belongsToExecution } from '../../../src/evidence-package/execution-correlation.ts';
import type { ExecutionIdentity, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { PROBE_ID, RUN_ID, at, digest, uuid } from '../../support/record-contract/record-builders.ts';
import { reasonCodes } from '../../support/evidence-package/package-files.ts';

const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
const ORIGINAL = digest('original-index');
const MANIFEST = digest('manifest');

function parsed(sequence: number, name: string, parent: string | null): ParsedAmendment {
  return {
    location: `amendments/${RUN_ID}/${name}/`,
    index_sha256: digest(name),
    files: [],
    index: {
      schema_version: 1,
      record_type: 'amendment_index',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST,
      amendment_id: uuid(0xb00 + sequence),
      amendment_kind: 'BILLING',
      sequence,
      original_package_index_sha256: ORIGINAL,
      parent_amendment_index_sha256: parent === null ? null : digest(parent),
      entries: [],
      created_at: at(sequence),
    },
  };
}

function graph(
  amendments: readonly ParsedAmendment[],
  head: Sha256Hex | null,
): ReturnType<typeof resolveAmendmentGraph> {
  const input: AmendmentGraphInput = {
    identity: RUN,
    execution_manifest_sha256: MANIFEST,
    original_package_index_sha256: ORIGINAL,
    amendments,
    selected_head: head,
  };
  return resolveAmendmentGraph(input);
}

const A = parsed(1, 'a', null);
const B = parsed(2, 'b', 'a');
const C = parsed(3, 'c', 'b');

describe('resolveAmendmentGraph', () => {
  it('accepts a complete linear chain selected at its head, in any input order', () => {
    const resolved = graph([C, A, B], digest('c'));
    assert.deepEqual(resolved.reasons, []);
    assert.deepEqual(
      resolved.selected_chain.map((amendment) => amendment.index.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      resolved.known_descendants.map((link) => link.sequence),
      [1, 2, 3],
    );
  });

  it('accepts no amendment and no head', () => {
    assert.deepEqual(graph([], null), { selected_chain: [], known_descendants: [], reasons: [] });
  });

  it('reports every amendment when no head is selected', () => {
    assert.deepEqual(reasonCodes(graph([A, B], null).reasons), ['UNSELECTED_DESCENDANT', 'UNSELECTED_DESCENDANT']);
  });

  it('reports an unknown head and leaves the chain empty', () => {
    const resolved = graph([A], digest('nowhere'));
    assert.deepEqual(reasonCodes(resolved.reasons), ['UNKNOWN_HEAD', 'UNSELECTED_DESCENDANT']);
    assert.deepEqual(resolved.selected_chain, []);
  });

  it('reports a fork: the sibling outside the chain is unselected', () => {
    const sibling = parsed(2, 'b2', 'a');
    const resolved = graph([A, B, sibling], digest('b'));
    assert.deepEqual(reasonCodes(resolved.reasons), ['UNSELECTED_DESCENDANT']);
    assert.match(resolved.reasons[0]?.detail ?? '', /b2/);
  });

  it('reports a parent on sequence 1, a parent of the wrong sequence and an unknown parent', () => {
    const rooted = parsed(1, 'r', 'x');
    const skipping = parsed(3, 's', 'a');
    const dangling = parsed(2, 'd', 'unknown');
    const orphan = parsed(2, 'n', null);
    const resolved = graph([A, rooted, skipping, dangling, orphan], digest('a'));
    const broken = resolved.reasons.filter((reason) => reason.code === 'BROKEN_PARENT').map((reason) => reason.detail);
    assert.equal(broken.length, 4);
    assert.match(broken[3] ?? '', /sequence 2 names parent null, no known amendment/);
    assert.match(broken[0] ?? '', /sequence 1 names parent .*; expected null/);
    assert.match(
      broken[1] ?? '',
      /an amendment of sequence 1; expected the index digest of the amendment of sequence 2/,
    );
    assert.match(broken[2] ?? '', /no known amendment/);
  });

  it('reports an amendment of another execution, manifest or original package', () => {
    const foreign: ParsedAmendment = { ...A, index: { ...A.index, run_id: uuid(0x777) } };
    const otherManifest: ParsedAmendment = {
      ...parsed(1, 'm', null),
      index: { ...parsed(1, 'm', null).index, execution_manifest_sha256: digest('other') },
    };
    const otherOriginal: ParsedAmendment = {
      ...parsed(1, 'o', null),
      index: { ...parsed(1, 'o', null).index, original_package_index_sha256: digest('other') },
    };
    const resolved = graph([foreign, otherManifest, otherOriginal], null);
    const details = resolved.reasons.filter((reason) => reason.code === 'BROKEN_PARENT').map((reason) => reason.detail);
    assert.equal(details.length, 3);
    assert.match(details[0] ?? '', /names another execution/);
    assert.match(details[1] ?? '', /execution_manifest_sha256/);
    assert.match(details[2] ?? '', /original_package_index_sha256/);
  });

  it('reports each run of missing sequences once', () => {
    const resolved = graph([parsed(2, 'b', 'a'), parsed(5, 'e', 'd'), parsed(7, 'g', 'f')], null);
    const gaps = resolved.reasons.filter((reason) => reason.code === 'SEQUENCE_GAP').map((reason) => reason.detail);
    assert.equal(gaps.length, 3);
    assert.match(gaps[0] ?? '', /sequence 1 is missing before 2/);
    assert.match(gaps[1] ?? '', /sequence 3\.\.4 is missing before 5/);
    assert.match(gaps[2] ?? '', /sequence 6 is missing before 7/);
  });

  it('reports a cycle once and still terminates the selected walk', () => {
    const x = parsed(2, 'x', 'y');
    const y = parsed(3, 'y', 'x');
    const resolved = graph([A, x, y], digest('y'));
    assert.deepEqual(resolved.reasons.filter((reason) => reason.code === 'CYCLE').length, 1);
    assert.deepEqual(
      resolved.selected_chain.map((amendment) => amendment.index_sha256),
      [digest('x'), digest('y')],
    );
  });

  it('reports a self-parent as a cycle', () => {
    const self = parsed(2, 'self', 'self');
    assert.ok(reasonCodes(graph([A, self], digest('self')).reasons).includes('CYCLE'));
  });

  it('reports two amendments that share one index digest', () => {
    const twin: ParsedAmendment = { ...A, location: 'amendments/other/' };
    const resolved = graph([A, twin], digest('a'));
    assert.deepEqual(reasonCodes(resolved.reasons), ['BROKEN_PARENT']);
    assert.match(resolved.reasons[0]?.detail ?? '', /shared with another amendment/);
    assert.equal(resolved.known_descendants.length, 2);
  });

  it('orders known descendants by sequence then digest', () => {
    const resolved = graph([parsed(1, 'z', null), parsed(1, 'a', null)], null);
    const digests = [digest('z'), digest('a')].toSorted();
    assert.deepEqual(
      resolved.known_descendants.map((link) => link.amendment_index_sha256),
      digests,
    );
  });

  it('links an amendment by its index digest', () => {
    assert.deepEqual(amendmentLink(A), {
      sequence: 1,
      amendment_id: A.index.amendment_id,
      amendment_kind: 'BILLING',
      amendment_index_sha256: digest('a'),
    });
  });
});

describe('belongsToExecution', () => {
  it('requires the one id of the execution and no other', () => {
    assert.equal(belongsToExecution({ run_id: RUN_ID }, RUN), true);
    assert.equal(belongsToExecution({ run_id: uuid(1) }, RUN), false);
    assert.equal(belongsToExecution({ run_id: RUN_ID, transport_probe_id: PROBE_ID }, RUN), false);
    assert.equal(
      belongsToExecution(
        { transport_probe_id: PROBE_ID },
        { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID },
      ),
      true,
    );
  });
});
