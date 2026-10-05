// AC-RUA-048 fuzz: the evidence-reference validator accepts exactly well-formed canonical lists,
// flags each malformed path, order and duplicate, and never throws on arbitrary JSON.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  compareEvidenceRefs,
  sortEvidenceRefs,
  validateEvidenceRefList,
} from '../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef, EvidenceRefViolation } from '../../../src/record-contract/evidence-refs.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const segment = fc.stringMatching(/^[a-z0-9_-][a-z0-9_.-]{0,7}$/);
const artifactPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((segments) => segments.join('/'));
const sha = fc.stringMatching(/^[0-9a-f]{64}$/);
const uuid = fc.uuid({ version: 4 });
const pointer = fc
  .array(fc.stringMatching(/^([^/~]|~[01]){0,4}$/), { maxLength: 3 })
  .map((tokens) => tokens.map((token) => `/${token}`).join(''));

function wellFormedRef(withIndex: boolean): fc.Arbitrary<EvidenceRef> {
  return fc
    .record(
      {
        artifact_path: artifactPath,
        artifact_sha256: sha,
        event_id: uuid,
        json_pointer: pointer,
        package_index_sha256: sha,
      },
      {
        requiredKeys: withIndex
          ? ['artifact_path', 'artifact_sha256', 'package_index_sha256']
          : ['artifact_path', 'artifact_sha256'],
        noNullPrototype: true,
      },
    )
    .map((ref) => ref as EvidenceRef);
}

function canonicalList(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return sortEvidenceRefs(refs).filter(
    (ref, index, sorted) => index === 0 || compareEvidenceRefs(sorted[index - 1] ?? ref, ref) !== 0,
  );
}

const violationsOf = (container: JsonValue): readonly EvidenceRefViolation[] =>
  validateEvidenceRefList(container, 'evidence_refs', 'inside_package').map((finding) => finding.violation);

const asJson = (refs: readonly EvidenceRef[]): JsonValue => refs as unknown as JsonValue;

describe('AC-RUA-048 evidence reference fuzz', () => {
  it('accepts every well-formed canonical list', () => {
    fc.assert(
      fc.property(
        fc.array(wellFormedRef(false), { maxLength: 6 }),
        fc.array(wellFormedRef(true), { maxLength: 6 }),
        (inside, crossing) => {
          assert.deepEqual(violationsOf({ evidence_refs: asJson(canonicalList(inside)) }), []);
          assert.deepEqual(
            validateEvidenceRefList(
              { evidence_refs: asJson(canonicalList(crossing)) },
              'evidence_refs',
              'outside_package',
            ),
            [],
          );
        },
      ),
      fuzzParameters(),
    );
  });

  it('flags every malformed path with its violation', () => {
    const corruption = fc.constantFrom<readonly [(path: string) => string, EvidenceRefViolation]>(
      [(path: string): string => `/${path}`, 'ABSOLUTE_PATH'],
      [(path: string): string => `C:/${path}`, 'ABSOLUTE_PATH'],
      [(path: string): string => `${path}/../x`, 'PARENT_TRAVERSAL'],
      [(path: string): string => `../${path}`, 'PARENT_TRAVERSAL'],
      [(path: string): string => `${path}//x`, 'NON_NORMALIZED_PATH'],
      [(path: string): string => `./${path}`, 'NON_NORMALIZED_PATH'],
      [(path: string): string => `${path}/`, 'NON_NORMALIZED_PATH'],
      [(path: string): string => path.replace(/^/, 'dir\\'), 'NON_NORMALIZED_PATH'],
    );
    fc.assert(
      fc.property(wellFormedRef(false), corruption, (ref, [corrupt, violation]) => {
        assert.deepEqual(
          violationsOf({ evidence_refs: asJson([{ ...ref, artifact_path: corrupt(ref.artifact_path) }]) }),
          [violation],
        );
      }),
      fuzzParameters(),
    );
  });

  it('flags reversed and duplicated lists', () => {
    const distinct = fc
      .array(wellFormedRef(false), { minLength: 2, maxLength: 6 })
      .map(canonicalList)
      .filter((refs) => refs.length >= 2);
    fc.assert(
      fc.property(distinct, fc.nat(), (refs, pick) => {
        assert.ok(violationsOf({ evidence_refs: asJson(refs.toReversed()) }).includes('UNSORTED'));
        const index = pick % refs.length;
        const picked = refs[index];
        assert.ok(picked !== undefined);
        const duplicated = [...refs.slice(0, index + 1), picked, ...refs.slice(index + 1)];
        assert.deepEqual(violationsOf({ evidence_refs: asJson(duplicated) }), ['DUPLICATE']);
      }),
      fuzzParameters(),
    );
  });

  it('never throws on arbitrary JSON and reports only closed violations', () => {
    const closed: ReadonlySet<string> = new Set([
      'ABSOLUTE_PATH',
      'PARENT_TRAVERSAL',
      'NON_NORMALIZED_PATH',
      'UNSORTED',
      'DUPLICATE',
      'ALIAS_FIELD',
      'CROSS_PACKAGE_WITHOUT_INDEX_DIGEST',
      'MALFORMED_FIELD',
    ]);
    const container = fc.oneof(
      fc.jsonValue() as fc.Arbitrary<JsonValue>,
      fc.record(
        { evidence_refs: fc.array(fc.jsonValue({ maxDepth: 2 })) },
        { noNullPrototype: true },
      ) as fc.Arbitrary<JsonValue>,
      fc.record(
        {
          evidence_refs: fc.array(
            fc.dictionary(
              fc.constantFrom(
                'artifact_path',
                'artifact_sha256',
                'event_id',
                'json_pointer',
                'package_index_sha256',
                'extra',
              ),
              fc.jsonValue({ maxDepth: 1 }),
              { noNullPrototype: true },
            ),
          ),
        },
        { noNullPrototype: true },
      ) as fc.Arbitrary<JsonValue>,
    );
    fc.assert(
      fc.property(
        container,
        fc.constantFrom('inside_package' as const, 'outside_package' as const),
        (value, location) => {
          for (const finding of validateEvidenceRefList(value, 'evidence_refs', location)) {
            assert.ok(closed.has(finding.violation), finding.violation);
            assert.ok(finding.detail.length > 0);
          }
        },
      ),
      fuzzParameters(),
    );
  });
});
