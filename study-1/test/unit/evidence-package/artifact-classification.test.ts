// Artifact classification by path (BR-RUA-037, AC-RUA-010; design §7): every layout path has one
// class and one derivation, a path outside the layout is unclassifiable, an invalid path is refused
// under BR-RUA-035 without being echoed as `artifact_path`, and an amendment payload must belong to
// its amendment kind (BR-RUA-043).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXECUTION_FILE_CLASSES,
  UNIT_FILE_CLASSES,
  classifyAmendmentPayload,
  classifyPackageArtifact,
  invalidPathReason,
  locateUnit,
} from '../../../src/evidence-package/artifact-classification.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS, UNIT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { ARTIFACT_CLASSES } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { TRIAL_ID } from '../../support/record-contract/record-builders.ts';

const TRIAL_DIR = `trials/${TRIAL_ID}`;

describe('classifyPackageArtifact', () => {
  it('classifies every execution-level path by its table entry', () => {
    for (const [key, expected] of Object.entries(EXECUTION_FILE_CLASSES)) {
      const path = EXECUTION_PATHS[key as keyof typeof EXECUTION_FILE_CLASSES];
      assert.deepEqual(classifyPackageArtifact(path), { ok: true, value: expected }, path);
    }
  });

  it('classifies trial files in a trial directory and probe files in the probe directory', () => {
    for (const [key, rule] of Object.entries(UNIT_FILE_CLASSES)) {
      const relative = UNIT_PATHS[key as keyof typeof UNIT_FILE_CLASSES];
      const expected = { artifact_class: rule.artifact_class, derivation: rule.derivation };
      const inTrial = classifyPackageArtifact(`${TRIAL_DIR}/${relative}`);
      const inProbe = classifyPackageArtifact(`probe/${relative}`);
      assert.deepEqual(
        inTrial.ok ? inTrial.value : 'refused',
        rule.units.includes('trial') ? expected : 'refused',
        key,
      );
      assert.deepEqual(
        inProbe.ok ? inProbe.value : 'refused',
        rule.units.includes('probe') ? expected : 'refused',
        key,
      );
    }
  });

  it('uses only classes of the closed vocabulary', () => {
    const classes = new Set<string>(ARTIFACT_CLASSES);
    for (const rule of [...Object.values(EXECUTION_FILE_CLASSES), ...Object.values(UNIT_FILE_CLASSES)]) {
      assert.ok(classes.has(rule.artifact_class), rule.artifact_class);
    }
  });

  it('flags exactly the derived results and operational results as derived', () => {
    const derived = Object.entries(UNIT_FILE_CLASSES)
      .filter(([, rule]) => rule.derivation === 'derived')
      .map(([key]) => key);
    assert.deepEqual(derived, ['attemptProjection', 'oracleResult', 'transportProbeResult', 'evidenceIndex']);
    assert.equal(EXECUTION_FILE_CLASSES.oracleRevisionCheck.derivation, 'primary');
    assert.equal(EXECUTION_FILE_CLASSES.runSummary.derivation, 'derived');
  });

  it('classifies schema copies and deployment-assembly files by directory', () => {
    assert.deepEqual(classifyPackageArtifact('admission/schemas/group-b/caller_event.schema.json'), {
      ok: true,
      value: { artifact_class: 'schema_file', derivation: 'primary' },
    });
    assert.deepEqual(classifyPackageArtifact('admission/deployment-assembly/asset.1/index.mjs'), {
      ok: true,
      value: { artifact_class: 'deployment_assembly_file', derivation: 'primary' },
    });
  });

  it('refuses a schema copy outside the group naming and the bare assembly directory', () => {
    for (const path of [
      'admission/schemas/group-d/x.schema.json',
      'admission/schemas/group-a/X.json',
      'admission/deployment-assembly/',
    ]) {
      const classified = classifyPackageArtifact(path);
      assert.equal(classified.ok, false, path);
    }
  });

  it('refuses a path outside the layout as UNCLASSIFIABLE_ARTIFACT_PATH, naming it', () => {
    for (const path of [
      'notes.txt',
      'trials/not-a-uuid/trial-manifest.json',
      TRIAL_DIR,
      `${TRIAL_DIR}/unknown.json`,
      'trials/x',
    ]) {
      const classified = classifyPackageArtifact(path);
      assert.deepEqual(
        classified.ok ? 'ok' : [classified.error.code, classified.error.subject, classified.error.artifact_path],
        ['UNCLASSIFIABLE_ARTIFACT_PATH', 'BR-RUA-037', path],
      );
    }
  });

  it('refuses an invalid path under BR-RUA-035 without echoing it as artifact_path', () => {
    for (const path of ['', '/abs/x.json', '../x.json', 'a//b.json', ' a.json']) {
      const classified = classifyPackageArtifact(path);
      assert.ok(!classified.ok);
      assert.equal(classified.error.code, 'INVALID_ARTIFACT_PATH');
      assert.equal(classified.error.subject, 'BR-RUA-035');
      assert.equal(Object.hasOwn(classified.error, 'artifact_path'), false);
    }
  });
});

describe('classifyAmendmentPayload', () => {
  it('classifies each payload for its own kinds', () => {
    assert.deepEqual(classifyAmendmentPayload(AMENDMENT_PATHS.lateEvidenceAssessment, 'REASSESSMENT'), {
      ok: true,
      value: { artifact_class: 'late_evidence_assessment', derivation: 'derived' },
    });
    assert.deepEqual(classifyAmendmentPayload(AMENDMENT_PATHS.lateEvidenceStream, 'LATE_EVIDENCE'), {
      ok: true,
      value: { artifact_class: 'late_evidence_stream', derivation: 'primary' },
    });
    assert.deepEqual(classifyAmendmentPayload('payload/billing-export/2026-10/part-0001.csv.gz', 'BILLING'), {
      ok: true,
      value: { artifact_class: 'billing_export_file', derivation: 'primary' },
    });
  });

  it('refuses a payload foreign to the amendment kind', () => {
    const classified = classifyAmendmentPayload(AMENDMENT_PATHS.billingImport, 'LATE_EVIDENCE');
    assert.ok(!classified.ok);
    assert.equal(classified.error.code, 'PAYLOAD_NOT_ALLOWED_FOR_KIND');
    assert.match(classified.error.detail, /BILLING payload; got amendment kind LATE_EVIDENCE/);
  });

  it('refuses the bare billing-export directory, unknown payloads and invalid paths', () => {
    const codes = ['payload/billing-export/', 'payload/notes.txt', 'amendment-index.json', '../x'].map((path) => {
      const classified = classifyAmendmentPayload(path, 'BILLING');
      return classified.ok ? 'ok' : classified.error.code;
    });
    assert.deepEqual(codes, [
      'INVALID_ARTIFACT_PATH',
      'UNCLASSIFIABLE_ARTIFACT_PATH',
      'UNCLASSIFIABLE_ARTIFACT_PATH',
      'INVALID_ARTIFACT_PATH',
    ]);
  });
});

describe('invalidPathReason and locateUnit', () => {
  it('accepts a normalized path and names the violation of others', () => {
    assert.equal(invalidPathReason('a/b.json'), undefined);
    assert.match(invalidPathReason('')?.detail ?? '', /EMPTY_PATH/);
    assert.match(invalidPathReason('/x')?.detail ?? '', /ABSOLUTE_PATH/);
  });

  it('splits trial and probe paths, and nothing else', () => {
    assert.deepEqual(locateUnit(`${TRIAL_DIR}/inputs/payment.json`), {
      unit: 'trial',
      relative: 'inputs/payment.json',
    });
    assert.deepEqual(locateUnit('probe/inputs/payment.json'), { unit: 'probe', relative: 'inputs/payment.json' });
    assert.equal(locateUnit('runner/runner-journal.jsonl'), undefined);
    assert.equal(locateUnit(`trials/${TRIAL_ID}`), undefined);
    assert.equal(locateUnit('trials/ABC/x.json'), undefined);
  });
});
