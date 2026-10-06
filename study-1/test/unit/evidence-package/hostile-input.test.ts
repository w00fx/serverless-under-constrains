// Owner amendment A-05 at the evidence-package boundaries (AC-RUA-046 feed: "the JSON, JSONL and
// package parsers never crash on malformed input"): every package record type, the verifier over a
// hostile derived record or amendment index, and an amendment with more files than a spread call
// takes as arguments. Each input is rejected with a bounded reason; nothing throws.
// package-index.test.ts, prefix-checkpoint.test.ts, assembly-inventory.test.ts and
// reference-resolution.test.ts cover the same classes for their own modules.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAmendments } from '../../../src/evidence-package/amendment-snapshots.ts';
import { AMENDMENT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { parsePackageRecord } from '../../../src/evidence-package/package-records.ts';
import type { PackageRecordType } from '../../../src/evidence-package/package-records.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import {
  FIXTURE_DEPS,
  FIXTURE_VALIDATOR,
  PROBE_PATHS,
  amendmentChain,
  billingPayload,
  indexedProbePackage,
  probePackage,
  replaceFile,
  verificationInput,
} from '../../support/evidence-package/probe-package-fixtures.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';

const SHAPES: readonly TowerShape[] = ['array', 'object', 'mixed'];

// `satisfies` keeps the list complete: a record type added to PackageRecordByType fails to compile here.
const RECORD_TYPES = Object.keys({
  package_index: true,
  evidence_index: true,
  amendment_index: true,
  deployment_assembly_inventory: true,
  coordination_prefix_checkpoint: true,
  late_evidence_assessment: true,
  operational_recovery_record: true,
  run_summary: true,
  validation_summary: true,
  transport_probe_summary: true,
} satisfies Record<PackageRecordType, true>) as readonly PackageRecordType[];

// Far below the 200,000 to 800,000 characters of a tower: a reason quotes, it never echoes.
const DETAIL_BOUND = 1_000;

// More than V8 accepts as the arguments of one call, so `push(...reasons)` throws RangeError.
const SPREAD_BREAKING_COUNT = 200_000;

function rejection(text: string, recordType: PackageRecordType): readonly [string, string] {
  const parsed = parsePackageRecord(utf8(text), recordType, FIXTURE_VALIDATOR, 'hostile/record.json');
  assert.ok(!parsed.ok, `${recordType} accepted ${text.slice(0, 40)}`);
  assert.equal(parsed.error.artifact_path, 'hostile/record.json');
  assert.ok(parsed.error.detail.length < DETAIL_BOUND, `${recordType}: ${String(parsed.error.detail.length)}`);
  return [parsed.error.code, parsed.error.detail];
}

function reasonsOf(verification: PackageVerification): readonly (readonly [string, string | undefined])[] {
  assert.ok(verification.package_ineligibility_reasons.every((reason) => reason.detail.length < DETAIL_BOUND));
  return verification.package_ineligibility_reasons.map((reason) => [reason.code, reason.artifact_path]);
}

describe('parsePackageRecord over hostile bytes (A-05)', () => {
  it('rejects a 100,000-level tower of every shape as a schema failure for every record type', () => {
    for (const shape of SHAPES) {
      const tower = towerText(shape, DEEP_NESTING, '1');
      for (const recordType of RECORD_TYPES) {
        const [code, detail] = rejection(tower, recordType);
        assert.equal(code, 'RECORD_SCHEMA_INVALID', `${shape} ${recordType}`);
        assert.ok(detail.endsWith(`; expected a valid ${recordType}`), detail);
      }
    }
  });

  it('rejects a non-finite number as unparseable for every record type, naming its pointer', () => {
    for (const recordType of RECORD_TYPES) {
      const [code, detail] = rejection(`{"schema_version":1e400,"record_type":"${recordType}"}`, recordType);
      assert.equal(code, 'RECORD_UNPARSEABLE', recordType);
      assert.equal(
        detail,
        `hostile/record.json: number at JSON pointer "/schema_version" overflows a finite double; expected one UTF-8 JSON ${recordType} document`,
      );
    }
  });

  it('reads inherited member names as own data, never as prototype members, for every record type', () => {
    for (const recordType of RECORD_TYPES) {
      const text = `{"__proto__":{"schema_version":1,"record_type":"${recordType}"},"constructor":1,"toString":2}`;
      const [code, detail] = rejection(text, recordType);
      assert.equal(code, 'RECORD_SCHEMA_INVALID', recordType);
      assert.match(detail, /record_type absent/);
    }
  });
});

describe('verifyPackage over hostile records (A-05)', () => {
  it('reports a 100,000-level derived record by its altered bytes, without reading it as references', () => {
    const fixture = probePackage();
    for (const shape of SHAPES) {
      const files = replaceFile(fixture.files, PROBE_PATHS.probeResult, utf8(towerText(shape, DEEP_NESTING, '1')));
      const verification = verifyPackage(verificationInput(indexedProbePackage(files), [], null), FIXTURE_DEPS);
      assert.deepEqual(reasonsOf(verification), [['ALTERED_BYTES', PROBE_PATHS.probeResult]], shape);
    }
  });

  it('reports a 100,000-level amendment index as unreadable and its head as unknown', () => {
    const fixture = probePackage();
    const [amendment] = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
    assert.ok(amendment !== undefined);
    for (const shape of SHAPES) {
      const tower = utf8(towerText(shape, DEEP_NESTING, '1'));
      const files = replaceFile(amendment.snapshot.files, AMENDMENT_PATHS.amendmentIndex, tower);
      const hostile = { ...amendment, snapshot: { ...amendment.snapshot, files } };
      const verification = verifyPackage(verificationInput(fixture, [hostile], amendment.index_sha256), FIXTURE_DEPS);
      assert.deepEqual(
        reasonsOf(verification).map(([code]) => code),
        ['ALTERED_BYTES', 'UNKNOWN_HEAD'],
        shape,
      );
    }
  });

  // Regression: readAmendments collected each amendment's reasons with `reasons.push(...read.reasons)`,
  // which threw RangeError ("Maximum call stack size exceeded") for an amendment holding 200,000
  // unindexed files instead of reporting them.
  it('reports every unindexed file of an amendment too large for a spread call', () => {
    const fixture = probePackage();
    const [amendment] = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
    assert.ok(amendment !== undefined);
    const extra = Array.from({ length: SPREAD_BREAKING_COUNT }, (_, position) => ({
      path: `payload/extra-${String(position)}.json`,
      bytes: utf8('{}'),
    }));
    const snapshot = { ...amendment.snapshot, files: [...amendment.snapshot.files, ...extra] };
    const read = readAmendments('amendments/hostile', [snapshot], FIXTURE_DEPS);
    assert.equal(read.amendments.length, 1);
    assert.equal(read.reasons.length, SPREAD_BREAKING_COUNT);
    assert.ok(read.reasons.every((reason) => reason.code === 'UNINDEXED_FILE'));
    const verification = verifyPackage(
      verificationInput(fixture, [{ ...amendment, snapshot }], amendment.index_sha256),
      FIXTURE_DEPS,
    );
    assert.equal(verification.package_ineligibility_reasons.length, SPREAD_BREAKING_COUNT);
  });
});
