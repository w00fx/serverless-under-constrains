// AC-RUA-046 feed (design §12.5 row 13): the package parsers never crash on malformed input. Every
// record the verifier reads back from package bytes goes through parsePackageRecord, which must
// return a reason, never throw, for any bytes and any JSON value; a package index that parses is
// always a schema-valid package index.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parsePackageIndex } from '../../../src/evidence-package/package-index.ts';
import { parsePackageRecord } from '../../../src/evidence-package/package-records.ts';
import type { PackageRecordType } from '../../../src/evidence-package/package-records.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { FIXTURE_DEPS, probePackage } from '../../support/evidence-package/probe-package-fixtures.ts';

const validator = createRecordValidator();
const encoder = new TextEncoder();
const RECORD_TYPES: readonly PackageRecordType[] = [
  'package_index',
  'evidence_index',
  'amendment_index',
  'deployment_assembly_inventory',
  'coordination_prefix_checkpoint',
  'late_evidence_assessment',
  'operational_recovery_record',
  'run_summary',
  'validation_summary',
  'transport_probe_summary',
];
const INDEX_BYTES = probePackage().files.find((file) => file.path === 'package-index.json')?.bytes ?? new Uint8Array();

describe('package parsers are total (AC-RUA-046)', () => {
  it('parsePackageIndex returns a result for any bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        const parsed = parsePackageIndex(bytes, validator);
        assert.equal(typeof parsed.ok, 'boolean');
      }),
      fuzzParameters(),
    );
  });

  it('parsePackageRecord returns a result for any JSON text of every record type (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RECORD_TYPES), fc.json({ maxDepth: 4 }), (recordType, text) => {
        const parsed = parsePackageRecord(encoder.encode(text), recordType, validator, 'x.json');
        assert.ok(parsed.ok || (parsed.error.code === 'RECORD_SCHEMA_INVALID' && parsed.error.detail.length > 0));
      }),
      fuzzParameters(),
    );
  });

  it('a mutated package index either fails to parse or still parses to a valid index (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: INDEX_BYTES.length - 1 }), fc.integer({ min: 1, max: 255 }), (offset, mask) => {
        const mutated = INDEX_BYTES.slice();
        mutated[offset] = (mutated[offset] ?? 0) ^ mask;
        const parsed = parsePackageIndex(mutated, FIXTURE_DEPS.validator);
        if (parsed.ok) {
          assert.ok(
            validator.validateAs(
              'package_index',
              JSON.parse(new TextDecoder().decode(serializeRecordFile(parsed.value))) as JsonValue,
            ).valid,
          );
        }
      }),
      fuzzParameters(),
    );
  });
});
