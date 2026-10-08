// Totality of the other untrusted-input boundaries of the evidence package (testing rule 6; Owner
// amendment A-05): path classification, the journal prefix reader, the container-asset manifest
// reader, the JSON pointer resolver and the reference walk return a value for any input and never
// throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  classifyAmendmentPayload,
  classifyPackageArtifact,
} from '../../../src/evidence-package/artifact-classification.ts';
import { containerAssetFindings } from '../../../src/evidence-package/container-assets.ts';
import { resolveJsonPointer } from '../../../src/evidence-package/json-pointer.ts';
import { lastPrefixEvent } from '../../../src/evidence-package/prefix-checkpoint.ts';
import { collectReferences, unresolvedReferenceReasons } from '../../../src/evidence-package/reference-resolution.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const encoder = new TextEncoder();
const pathSegment = fc.constantFrom(
  'trials',
  'probe',
  'admission',
  'payload',
  'derived',
  '..',
  '.',
  '',
  'x.json',
  'evidence-index.json',
  '00000000-0000-4000-8000-000000000103',
);
const layoutLikePath = fc.array(pathSegment, { minLength: 1, maxLength: 5 }).map((segments) => segments.join('/'));

describe('evidence-package input boundaries are total (property)', () => {
  it('classification returns a result for any path and amendment kind', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), layoutLikePath),
        fc.constantFrom('LATE_EVIDENCE', 'OPERATIONAL_RECOVERY', 'BILLING', 'REASSESSMENT' as const),
        (path, kind) => {
          const packageResult = classifyPackageArtifact(path);
          const payloadResult = classifyAmendmentPayload(path, kind);
          assert.equal(typeof packageResult.ok, 'boolean');
          assert.equal(typeof payloadResult.ok, 'boolean');
        },
      ),
      fuzzParameters(),
    );
  });

  it('the journal prefix reader returns a result for any bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 128 }),
          fc.json({ maxDepth: 3 }).map((text) => encoder.encode(`${text}\n`)),
        ),
        (prefix) => {
          assert.equal(typeof lastPrefixEvent(prefix).ok, 'boolean');
        },
      ),
      fuzzParameters(),
    );
  });

  it('the container-asset reader returns findings for any manifest bytes', () => {
    const manifestText = fc.oneof(
      fc.json({ maxDepth: 4 }),
      fc
        .jsonValue({ maxDepth: 3 })
        .map((value) => JSON.stringify({ dockerImages: value, artifacts: { A: { metadata: { '/p': [value] } } } })),
    );
    fc.assert(
      fc.property(fc.constantFrom('S.assets.json', 'manifest.json'), manifestText, (path, text) => {
        const findings = containerAssetFindings([{ path, bytes: encoder.encode(text) }]);
        assert.ok(findings.every((finding) => finding.subject === 'BR-RUA-042'));
      }),
      fuzzParameters(),
    );
  });

  it('the pointer resolver and the reference walk return a value for any JSON', () => {
    fc.assert(
      fc.property(
        fc.jsonValue({ maxDepth: 4 }),
        fc.oneof(
          fc.string(),
          fc.array(fc.string(), { maxLength: 4 }).map((tokens) => tokens.map((token) => `/${token}`).join('')),
        ),
        (document, pointer) => {
          const value = document as JsonValue;
          const resolved = resolveJsonPointer(value, pointer);
          assert.equal(typeof resolved.found, 'boolean');
          assert.ok(Array.isArray(collectReferences(value)));
        },
      ),
      fuzzParameters(),
    );
  });

  it('reference resolution returns reasons for any derived record', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (record) => {
        const bytes = encoder.encode(JSON.stringify({ evidence_refs: [record], x_ref: record }));
        const path = 'probe/derived/transport-probe-result.json';
        const reasons = unresolvedReferenceReasons(
          {
            entries: [
              {
                artifact_path: path,
                artifact_class: 'transport_probe_result',
                derivation: 'derived',
                bytes: bytes.length,
                sha256: sha256Hex(bytes),
              },
            ],
            files: [{ path, bytes }],
            referenced_package_indexes: [],
          },
          sha256Hex,
        );
        assert.ok(reasons.every((reason) => reason.code === 'UNRESOLVED_REFERENCE'));
      }),
      fuzzParameters(),
    );
  });
});
