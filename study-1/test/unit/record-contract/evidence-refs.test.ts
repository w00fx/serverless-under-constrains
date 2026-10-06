// AC-RUA-048 — Evidence References Are Well Formed (BR-RUA-035). Case names follow design §14:
// absolute-path, parent-traversal, unsorted, duplicate, alias-field, pass-without-references,
// missing-evidence-empty-with-reason. Further cases pin each remaining violation and the order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVIDENCE_REF_ALIASES,
  MISSING_EVIDENCE_REASON_CODES,
  classifyArtifactPath,
  compareEvidenceRefs,
  isOrderableEvidenceRef,
  sortEvidenceRefs,
  validateEvidenceRefList,
  validateResultReferences,
} from '../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef, EvidenceRefFinding } from '../../../src/record-contract/evidence-refs.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { JsonValue, Sha256Hex, StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';

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
    assert.equal(
      findings[0]?.detail,
      'evidence_refs[1] repeats an earlier reference evidence_refs[0] (artifact_path "ledger/a.json"); expected each reference once',
    );
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
    const byArtifact: StructuredReason = {
      code: 'ARTIFACT_MISSING',
      subject: 'BR-RUA-001',
      artifact_path: 'ledger/ledger-snapshot.json',
      detail: 'absent',
    };
    const byEvent: StructuredReason = {
      code: 'CAUSAL_PREDECESSOR_MISSING',
      subject: 'BR-RUA-004',
      event_id: EVENT_1,
      detail: 'absent',
    };
    const byInput: StructuredReason = {
      code: 'INPUT_MISSING',
      subject: 'BR-RUA-009',
      artifact_path: 'inputs/approved-decision.json',
      detail: 'absent',
    };
    const vague: StructuredReason = { code: 'UNKNOWN', subject: 'BR-RUA-001', detail: 'no idea' };
    assert.deepEqual(MISSING_EVIDENCE_REASON_CODES, [
      'ARTIFACT_MISSING',
      'CAUSAL_PREDECESSOR_MISSING',
      'INPUT_MISSING',
    ]);
    assert.deepEqual(validateResultReferences('indeterminate', [], [byArtifact]), []);
    assert.deepEqual(validateResultReferences('indeterminate', [], [byArtifact, byEvent, byInput]), []);
    // BR-RUA-035: only a result caused ENTIRELY by missing evidence may carry an empty list.
    assert.deepEqual(validateResultReferences('indeterminate', [], [vague, byEvent]), [
      'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON',
    ]);
    assert.deepEqual(validateResultReferences('indeterminate', [], [byArtifact, vague]), [
      'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON',
    ]);
    assert.deepEqual(validateResultReferences('indeterminate', [], [vague]), ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON']);
    assert.deepEqual(validateResultReferences('indeterminate', [], []), ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON']);
    assert.deepEqual(validateResultReferences('indeterminate', [ref('ledger/a.json')], []), []);
    // WP-00 review round 2: naming an artifact is not enough when the cause is not its absence.
    // The digest mismatch concerns evidence that exists and can be referenced.
    const mismatch: StructuredReason = { ...byArtifact, code: 'CORE_FILE_DIGEST_MISMATCH' };
    assert.deepEqual(validateResultReferences('indeterminate', [], [mismatch]), [
      'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON',
    ]);
    assert.deepEqual(validateResultReferences('indeterminate', [], [byArtifact, mismatch]), [
      'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON',
    ]);
    // A missing-evidence code must still identify what is missing.
    const unnamed: StructuredReason = { code: 'ARTIFACT_MISSING', subject: 'G5', detail: 'something is absent' };
    assert.deepEqual(validateResultReferences('indeterminate', [], [unnamed]), [
      'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON',
    ]);
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
    ['C:\\windows\\x', 'ABSOLUTE_PATH'],
    ['z:/', 'ABSOLUTE_PATH'],
    // A colon is legal in a relative POSIX name; only a rooted drive is absolute.
    ['c:relative', undefined],
    ['a:b.json', undefined],
    ['ab:/x', undefined],
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
    assert.match(findings[1]?.detail ?? '', /evidence_refs\[1\]\["note"\] is not a BR-RUA-035 field/);
  });

  it('reads only an own field, so an inherited name is absent rather than a prototype member', () => {
    for (const field of ['constructor', 'toString', '__proto__']) {
      const findings = validateEvidenceRefList({ result: 'pass' }, field, 'inside_package');
      assert.deepEqual(violations(findings), ['MALFORMED_FIELD'], field);
      assert.match(findings[0]?.detail ?? '', /is absent; expected an array/, field);
    }
    const own = JSON.parse('{"constructor":[]}') as JsonValue;
    assert.deepEqual(validateEvidenceRefList(own, 'constructor', 'inside_package'), []);
  });

  // WP-00 review round 2 (A-05 policy 1): an unknown member name and a duplicate's identity were
  // copied whole into the detail, so a 5 MB name or path made a 5 MB finding.
  it('keeps every detail bounded however long the untrusted name or path is', () => {
    const huge = 'p'.repeat(5_000_000);
    const unknown = validateEvidenceRefList(container([{ ...ref('a'), [huge]: 1 }]), 'evidence_refs', 'inside_package');
    assert.deepEqual(violations(unknown), ['MALFORMED_FIELD']);
    assert.equal(
      unknown[0]?.detail,
      `evidence_refs[0]["${'p'.repeat(QUOTED_JSON_LIMIT - 1)}…[truncated]] is not a BR-RUA-035 field; expected only artifact_path, artifact_sha256, event_id, json_pointer, package_index_sha256`,
    );
    const longPath = `${'d/'.repeat(2_500_000)}x.json`;
    const duplicate = validateEvidenceRefList(
      container(asJson([ref(longPath), ref(longPath)])),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(duplicate), ['DUPLICATE']);
    assert.equal(
      duplicate[0]?.detail,
      `evidence_refs[1] repeats an earlier reference evidence_refs[0] (artifact_path "${longPath.slice(0, QUOTED_JSON_LIMIT - 1)}…[truncated]); expected each reference once`,
    );
    const pathFinding = validateEvidenceRefList(
      container(asJson([ref(`/${huge}`)])),
      'evidence_refs',
      'inside_package',
    );
    assert.ok((pathFinding[0]?.detail.length ?? Infinity) < 2 * QUOTED_JSON_LIMIT, pathFinding[0]?.detail.slice(0, 80));
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

describe('hostile reference members (Owner amendment A-02 regression)', () => {
  const MEMBERS = ['artifact_path', 'artifact_sha256', 'event_id', 'json_pointer', 'package_index_sha256'] as const;
  const hostile = (): JsonValue => JSON.parse('{"toString":1,"valueOf":1}') as JsonValue;
  const nullPrototype = (): JsonValue => Object.create(null) as JsonValue;

  it('orders only objects whose ordering members are absent or strings', () => {
    const full = ref('a', { event_id: EVENT_1, json_pointer: '/x', package_index_sha256: SHA_B });
    assert.equal(isOrderableEvidenceRef(full), true);
    assert.equal(isOrderableEvidenceRef(ref('a')), true);
    assert.equal(isOrderableEvidenceRef({}), true, 'absent members sort first; `required` reports them');
    assert.equal(isOrderableEvidenceRef(Object.assign(Object.create(null) as object, ref('a'))), true);
    for (const value of [null, 'a', 7, [], [ref('a')]]) {
      assert.equal(isOrderableEvidenceRef(value), false, JSON.stringify(value));
    }
    for (const member of MEMBERS) {
      for (const value of [hostile(), nullPrototype(), 7, null, true, ['x']]) {
        assert.equal(isOrderableEvidenceRef({ ...full, [member]: value }), false, `${member} ${JSON.stringify(value)}`);
      }
    }
  });

  it('reports a hostile member as MALFORMED_FIELD, never as an order finding or a crash', () => {
    for (const member of MEMBERS) {
      for (const value of [hostile(), nullPrototype()]) {
        const entries = asJson([ref('a', { event_id: EVENT_1 }), ref('b', { event_id: EVENT_2 })]);
        const second = { ...(entries[1] as Readonly<Record<string, JsonValue>>), [member]: value };
        const findings = validateEvidenceRefList(
          container([entries[0] ?? null, second]),
          'evidence_refs',
          'inside_package',
        );
        assert.deepEqual(violations(findings), ['MALFORMED_FIELD'], member);
        assert.ok(
          findings[0]?.detail.startsWith(`evidence_refs[1].${member} is object {`),
          `${member}: ${JSON.stringify(findings)}`,
        );
      }
    }
  });

  it('reports a hostile or null-prototype entry without throwing', () => {
    const findings = validateEvidenceRefList(
      container([hostile(), Object.assign(Object.create(null) as object, ref('a')) as JsonValue]),
      'evidence_refs',
      'inside_package',
    );
    assert.deepEqual(violations(findings), [
      'MALFORMED_FIELD',
      'MALFORMED_FIELD',
      'MALFORMED_FIELD',
      'MALFORMED_FIELD',
    ]);
    assert.match(findings[0]?.detail ?? '', /evidence_refs\[0\]\["toString"\] is not a BR-RUA-035 field/);
  });
});
