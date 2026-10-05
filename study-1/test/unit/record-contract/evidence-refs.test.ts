// AC-RUA-048 — Evidence References Are Well Formed (BR-RUA-035). Case names follow design §14:
// absolute-path, parent-traversal, unsorted, duplicate, alias-field, pass-without-references,
// missing-evidence-empty-with-reason. Further cases pin each remaining violation and the order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVIDENCE_REF_ALIASES,
  classifyArtifactPath,
  compareEvidenceRefs,
  sortEvidenceRefs,
  validateEvidenceRefList,
  validateResultReferences,
} from '../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef, EvidenceRefFinding } from '../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';

const SHA_A = 'a'.repeat(64) as Sha256Hex;
const SHA_B = 'b'.repeat(64) as Sha256Hex;
const EVENT_1 = '00000000-0000-4000-8000-000000000001' as Uuid4;
const EVENT_2 = '00000000-0000-4000-8000-000000000002' as Uuid4;

function ref(artifact_path: string, extra: Partial<EvidenceRef> = {}): EvidenceRef {
  return { artifact_path, artifact_sha256: SHA_A, ...extra };
}

function container(refs: readonly JsonValue[], extra: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return { result: 'pass', evidence_refs: refs, ...extra };
}

function violations(findings: readonly EvidenceRefFinding[]): readonly string[] {
  return findings.map((finding) => finding.violation);
}

function asJson(refs: readonly EvidenceRef[]): readonly JsonValue[] {
  return refs.map((entry) => ({ ...entry }));
}

describe('AC-RUA-048 evidence references are well formed', () => {
  it('absolute-path', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('/evidence/ledger.json')])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['ABSOLUTE_PATH']);
    assert.match(
      findings[0]?.detail ?? '',
      /"\/evidence\/ledger\.json"; expected a normalized package-relative POSIX path/,
    );
  });

  it('parent-traversal', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('trials/t/../../other/x.json')])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['PARENT_TRAVERSAL']);
  });

  it('unsorted', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('ledger/b.json'), ref('ledger/a.json')])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['UNSORTED']);
    assert.match(findings[0]?.detail ?? '', /evidence_refs\[1\] sorts before evidence_refs\[0\]/);
  });

  it('duplicate', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('ledger/a.json'), ref('ledger/a.json')])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['DUPLICATE']);
    assert.match(findings[0]?.detail ?? '', /evidence_refs\[1\] repeats an earlier reference/);
  });

  it('alias-field', () => {
    for (const alias of EVIDENCE_REF_ALIASES) {
      const findings = validateEvidenceRefList(
        container(asJson([ref('ledger/a.json')]), { [alias]: [] }),
        'evidence_refs',
        'inside_package',
      );
      assert.deepEqual(violations(findings), ['ALIAS_FIELD'], alias);
      assert.match(findings[0]?.detail ?? '', new RegExp(`"${alias}" is an alias`));
    }
    const onlyAlias = validateEvidenceRefList({ result: 'pass', evidence: [] }, 'evidence_refs', 'inside_package');
    assert.deepEqual(violations(onlyAlias), ['ALIAS_FIELD', 'MALFORMED_FIELD']);
  });

  it('pass-without-references', () => {
    assert.deepEqual(validateResultReferences('pass', [], []), ['MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT']);
    assert.deepEqual(validateResultReferences('fail', [], []), ['MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT']);
    assert.deepEqual(validateResultReferences('pass', [ref('ledger/a.json')], []), []);
  });

  it('missing-evidence-empty-with-reason', () => {
    const byArtifact = {
      code: 'ARTIFACT_MISSING',
      subject: 'BR-RUA-001',
      artifact_path: 'ledger/ledger-snapshot.json',
      detail: 'absent',
    };
    const byEvent = { code: 'EVENT_MISSING', subject: 'BR-RUA-004', event_id: EVENT_1, detail: 'absent' };
    const vague = { code: 'UNKNOWN', subject: 'BR-RUA-001', detail: 'no idea' };
    assert.deepEqual(validateResultReferences('indeterminate', [], [byArtifact]), []);
    assert.deepEqual(validateResultReferences('indeterminate', [], [vague, byEvent]), []);
    assert.deepEqual(validateResultReferences('indeterminate', [], [vague]), ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON']);
    assert.deepEqual(validateResultReferences('indeterminate', [], []), ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON']);
    assert.deepEqual(validateResultReferences('indeterminate', [ref('ledger/a.json')], []), []);
  });
});

describe('artifact path classification', () => {
  const cases: readonly [string, string | undefined][] = [
    ['trials/t/ledger/ledger-snapshot.json', undefined],
    ['package-index.json', undefined],
    ['.hidden/file.json', undefined],
    ['a..b/c', undefined],
    ['/abs', 'ABSOLUTE_PATH'],
    ['C:/windows/x', 'ABSOLUTE_PATH'],
    ['c:relative', 'ABSOLUTE_PATH'],
    ['..', 'PARENT_TRAVERSAL'],
    ['a/../b', 'PARENT_TRAVERSAL'],
    ['a/..', 'PARENT_TRAVERSAL'],
    ['', 'NON_NORMALIZED_PATH'],
    ['a//b', 'NON_NORMALIZED_PATH'],
    ['a/b/', 'NON_NORMALIZED_PATH'],
    ['./a', 'NON_NORMALIZED_PATH'],
    ['a/./b', 'NON_NORMALIZED_PATH'],
    ['a\\b', 'NON_NORMALIZED_PATH'],
    ['1:/x', undefined],
  ];
  for (const [path, expected] of cases) {
    it(`classifies ${JSON.stringify(path)} as ${String(expected)}`, () => {
      assert.equal(classifyArtifactPath(path), expected);
    });
  }
});

describe('canonical reference order', () => {
  it('orders by path, then digest, then event, pointer and package digest, absent first', () => {
    const ordered = [
      ref('a'),
      ref('a', { event_id: EVENT_1 }),
      ref('a', { event_id: EVENT_1, json_pointer: '/x' }),
      ref('a', { event_id: EVENT_1, json_pointer: '/x', package_index_sha256: SHA_A }),
      ref('a', { event_id: EVENT_1, json_pointer: '/x', package_index_sha256: SHA_B }),
      ref('a', { event_id: EVENT_1, json_pointer: '/y' }),
      ref('a', { event_id: EVENT_2 }),
      ref('a', { artifact_sha256: SHA_B }),
      ref('a/b'),
      ref('b'),
    ];
    const shuffled = [
      ordered[7],
      ordered[2],
      ordered[9],
      ordered[0],
      ordered[5],
      ordered[3],
      ordered[8],
      ordered[1],
      ordered[6],
      ordered[4],
    ];
    assert.deepEqual(sortEvidenceRefs(shuffled.filter((entry) => entry !== undefined)), ordered);
    for (let index = 1; index < ordered.length; index += 1) {
      const [earlier, later] = [ordered[index - 1], ordered[index]];
      assert.ok(earlier !== undefined && later !== undefined);
      assert.equal(compareEvidenceRefs(earlier, later), -1, `${String(index - 1)} before ${String(index)}`);
      assert.equal(compareEvidenceRefs(later, earlier), 1, `${String(index)} after ${String(index - 1)}`);
    }
  });

  it('compares equal references as 0 and leaves the input untouched', () => {
    const input = [ref('b'), ref('a')];
    assert.equal(compareEvidenceRefs(ref('a', { event_id: EVENT_1 }), ref('a', { event_id: EVENT_1 })), 0);
    assert.deepEqual(sortEvidenceRefs(input), [ref('a'), ref('b')]);
    assert.deepEqual(input, [ref('b'), ref('a')]);
  });

  it('accepts a canonical list with every optional field', () => {
    const refs = [
      ref('a', { event_id: EVENT_1, json_pointer: '', package_index_sha256: SHA_B }),
      ref('a/~0b', { json_pointer: '/a~1b/0' }),
    ];
    assert.deepEqual(validateEvidenceRefList(container(asJson(refs)), 'evidence_refs', 'inside_package'), []);
    assert.deepEqual(validateEvidenceRefList(container([]), 'evidence_refs', 'inside_package'), []);
  });

  it('reports a duplicate that is not adjacent together with the disorder', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('b'), ref('a'), ref('b')])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['UNSORTED', 'DUPLICATE']);
  });
});

describe('malformed reference lists', () => {
  it('rejects a container that is not an object', () => {
    for (const value of [null, [], 'refs', 3] as const) {
      const findings = validateEvidenceRefList(value, 'evidence_refs', 'inside_package');
      assert.deepEqual(violations(findings), ['MALFORMED_FIELD']);
      assert.match(findings[0]?.detail ?? '', /expected a JSON object/);
    }
    assert.match(
      validateEvidenceRefList([], 'evidence_refs', 'inside_package')[0]?.detail ?? '',
      /container is array \[\]/,
    );
    assert.match(
      validateEvidenceRefList(null, 'evidence_refs', 'inside_package')[0]?.detail ?? '',
      /container is null null/,
    );
  });

  it('rejects a missing or non-array field under its own name', () => {
    const missing = validateEvidenceRefList({ result: 'pass' }, 'refs_field', 'inside_package');
    assert.deepEqual(violations(missing), ['MALFORMED_FIELD']);
    assert.match(missing[0]?.detail ?? '', /field "refs_field" is absent; expected an array/);
    const wrongType = validateEvidenceRefList({ evidence_refs: {} }, 'evidence_refs', 'inside_package');
    assert.match(wrongType[0]?.detail ?? '', /field "evidence_refs" is object \{\}/);
  });

  it('rejects entries that are not objects or carry unknown fields', () => {
    const findings = validateEvidenceRefList(
      container([7, { ...ref('a'), note: 'x' }]),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['MALFORMED_FIELD', 'MALFORMED_FIELD']);
    assert.match(findings[0]?.detail ?? '', /evidence_refs\[0\] is number 7; expected a JSON object/);
    assert.match(findings[1]?.detail ?? '', /evidence_refs\[1\]\.note is not a BR-RUA-035 field/);
  });

  it('rejects malformed field values one by one', () => {
    const bad = [
      [{ artifact_sha256: SHA_A }, /artifact_path is absent/],
      [{ artifact_path: '', artifact_sha256: SHA_A }, /artifact_path is string ""/],
      [{ artifact_path: 3, artifact_sha256: SHA_A }, /artifact_path is number 3/],
      [{ artifact_path: 'a' }, /artifact_sha256 is absent; expected 64 lowercase hex/],
      [{ artifact_path: 'a', artifact_sha256: 'A'.repeat(64) }, /artifact_sha256 is string/],
      [{ ...ref('a'), event_id: 'not-a-uuid' }, /event_id is string "not-a-uuid"; expected a lowercase UUIDv4/],
      [{ ...ref('a'), json_pointer: 'no-slash' }, /json_pointer is string "no-slash"; expected an RFC 6901 pointer/],
      [{ ...ref('a'), json_pointer: '/bad~2escape' }, /json_pointer/],
      [{ ...ref('a'), json_pointer: 5 }, /json_pointer is number 5/],
      [
        { ...ref('a'), package_index_sha256: 'short' },
        /package_index_sha256 is string "short"; expected 64 lowercase hex/,
      ],
    ] as const;
    for (const [entry, pattern] of bad) {
      const findings = validateEvidenceRefList(container([entry]), 'evidence_refs', 'inside_package');
      assert.deepEqual(violations(findings), ['MALFORMED_FIELD'], JSON.stringify(entry));
      assert.match(findings[0]?.detail ?? '', pattern);
    }
  });

  it('skips order checks while entries are malformed', () => {
    const findings = validateEvidenceRefList(
      container([{ ...ref('b') }, { artifact_path: 'a' }]),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), ['MALFORMED_FIELD']);
  });
});

describe('cross-package references', () => {
  it('requires a package index digest on every reference held outside a package', () => {
    const findings = validateEvidenceRefList(
      container(asJson([ref('a'), ref('b', { package_index_sha256: SHA_B })])),
      'evidence_refs',
      'outside_package',
    );
    assert.deepEqual(violations(findings), ['CROSS_PACKAGE_WITHOUT_INDEX_DIGEST']);
    assert.match(findings[0]?.detail ?? '', /evidence_refs\[0\] is held outside every package/);
  });

  it('accepts a reference without digest inside its own package', () => {
    assert.deepEqual(validateEvidenceRefList(container(asJson([ref('a')])), 'evidence_refs', 'inside_package'), []);
    assert.deepEqual(
      validateEvidenceRefList(
        container(asJson([ref('a', { package_index_sha256: SHA_B })])),
        'evidence_refs',
        'outside_package',
      ),
      [],
    );
  });
});
