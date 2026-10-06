// The `billing_import` record (catalogue row 86) of one export: refusal only when the inputs, the
// CSV or the billing period are unusable; everything else is a schema-valid record whose check may be
// `unverified`. The record composes into a BILLING amendment with the export's exact bytes
// (BR-RUA-043), which the operator CLI assembles.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { buildBillingImport } from '../../../src/billing-amendment/billing-import.ts';
import type { BillingImportInput } from '../../../src/billing-amendment/billing-import.ts';
import { CUR_LINE_COLUMNS, CUR_PERIOD_COLUMNS } from '../../../src/billing-amendment/cur-export.ts';
import { buildAmendment } from '../../../src/evidence-package/amendments.ts';
import { AMENDMENT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { BillingImport } from '../../../src/record-contract/records/group-c/billing_import.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  CUR_HEADER,
  MANIFEST_SHA256,
  PACKAGE_INDEX_SHA256,
  RUN_CONTEXT,
  RUN_ID,
  billingExportFixture,
  csvBytes,
  curCsv,
  curRecord,
  runImport,
} from './support/cur-export-builder.ts';

const validator = createRecordValidator();

function imported(input: BillingImportInput): BillingImport {
  const built = buildBillingImport(input);
  assert.ok(built.ok, JSON.stringify(built));
  const verdict = validator.validateAs('billing_import', built.value as unknown as JsonValue);
  assert.ok(verdict.valid, JSON.stringify(verdict));
  return built.value;
}

function refusals(input: BillingImportInput): readonly (readonly [string, string])[] {
  const built = buildBillingImport(input);
  assert.ok(!built.ok, JSON.stringify(built));
  return built.error.map((reason) => [reason.code, reason.detail.split('; expected')[0] ?? ''] as const);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ONE_LINE = csvBytes(curCsv([curRecord()]));

describe('buildBillingImport writes the billing_import record', () => {
  it('states the identity, digests, export, window, ceiling and check', () => {
    const record = imported(runImport(ONE_LINE));
    assert.deepEqual(record, {
      schema_version: 1,
      record_type: 'billing_import',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA256,
      original_package_index_sha256: PACKAGE_INDEX_SHA256,
      billing_export: {
        export_sha256: sha256(ONE_LINE),
        period_start: '2026-10-01T00:00:00.000Z',
        period_end: '2026-11-01T00:00:00.000Z',
        period_final: true,
      },
      attribution_window_start: '2026-10-05T10:00:00.000Z',
      attribution_window_end: '2026-10-05T12:00:00.000Z',
      lines_used: [
        {
          line_id: 'row:1',
          product_code: 'AWSLambda',
          operation: 'Invoke',
          resource_id: 'arn:aws:lambda:us-east-1:123456789012:function:suc-run-provider',
          usage_start: '2026-10-05T10:00:00.000Z',
          usage_end: '2026-10-05T11:00:00.000Z',
          currency: 'USD',
          cost: '0.5',
        },
      ],
      exclusions: [],
      ceiling_usd: '5.00',
      billed_cost_check: 'within_limit',
      attributed_total_usd: '0.5',
      reasons: [],
      imported_at: '2026-11-04T09:00:00.000Z',
    });
  });

  it('names a probe or a validation by its own identity field and tag', () => {
    const probeId = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081' as Uuid4;
    const probeExport = csvBytes(curCsv([curRecord({ [CUR_LINE_COLUMNS.run_tag]: probeId })]));
    const probe = imported(
      runImport(probeExport, {
        context: { ...RUN_CONTEXT, identity: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: probeId } },
        ceiling_usd: '1.00',
      }),
    );
    assert.equal('transport_probe_id' in probe ? probe.transport_probe_id : undefined, probeId);
    assert.equal('run_id' in probe, false);
    assert.equal(probe.billed_cost_check, 'within_limit');
  });

  it('digests the exact stored bytes of a gzip export and reads it like the plain one', () => {
    const compressed = gzipSync(ONE_LINE);
    const record = imported(runImport(compressed));
    assert.equal(record.billing_export.export_sha256, sha256(compressed));
    assert.deepEqual(record.lines_used, imported(runImport(ONE_LINE)).lines_used);
  });

  it('is unverified with INCOMPLETE_ATTRIBUTION when the export lacks a line column', () => {
    const header = CUR_HEADER.filter((column) => column !== CUR_LINE_COLUMNS.resource_id);
    const record = imported(runImport(csvBytes(curCsv([curRecord()], header))));
    assert.equal(record.billed_cost_check, 'unverified');
    assert.deepEqual(record.lines_used, []);
    assert.deepEqual(record.exclusions, []);
    assert.deepEqual(
      record.reasons.map((reason) => reason.code),
      ['INCOMPLETE_ATTRIBUTION'],
    );
  });

  it('is unverified with INCOMPLETE_PERIOD when the period is not final, whatever the lines', () => {
    const notFinal = csvBytes(curCsv([curRecord({ [CUR_PERIOD_COLUMNS.invoice]: '' })]));
    const record = imported(runImport(notFinal));
    assert.equal(record.billed_cost_check, 'unverified');
    assert.equal(record.billing_export.period_final, false);
    assert.deepEqual(
      record.reasons.map((reason) => reason.code),
      ['INCOMPLETE_PERIOD'],
    );
    assert.equal(record.lines_used.length, 1);
  });

  it('is unverified, never a guessed amount, on non-finite costs (A-05)', () => {
    const hostile = csvBytes(
      curCsv([curRecord({ [CUR_LINE_COLUMNS.cost]: '1e400' }), curRecord({ [CUR_LINE_COLUMNS.cost]: 'Infinity' })]),
    );
    const record = imported(runImport(hostile));
    assert.equal(record.billed_cost_check, 'unverified');
    assert.match(
      record.reasons.map((reason) => reason.detail).join('\n'),
      /^2 line\(s\): row:1 \(unreadable cost "1e400" "USD"\), row:2/,
    );
  });

  it('imports 150,000 attributable lines without throwing (A-05)', () => {
    const header = CUR_HEADER.join(',');
    const row = CUR_HEADER.map((column) => curRecord()[column] ?? '').join(',');
    // Built directly: the property under test is totality, and schema validation of 150,000 lines
    // would double the case's time without proving more than the smaller cases above.
    const built = buildBillingImport(runImport(csvBytes(`${header}\n${`${row}\n`.repeat(150_000)}`)));
    assert.ok(built.ok, 'the import must not refuse an export of well-formed lines');
    const record = built.value;
    // 150,000 x 0.5 = 75000 > 5.00.
    assert.equal(record.billed_cost_check, 'breached');
    assert.equal('attributed_total_usd' in record ? record.attributed_total_usd : undefined, '75000');
    assert.equal(record.lines_used.length, 150_000);
  });

  it('records the AC-RUA-034 non-USD fixture as a valid BILLING amendment payload', () => {
    const exportBytes = billingExportFixture('non-usd-line.csv');
    const record = imported(runImport(exportBytes));
    const amendment = buildAmendment({
      identity: RUN_CONTEXT.identity,
      execution_manifest_sha256: MANIFEST_SHA256 as Sha256Hex,
      amendment_id: '3d4e5f60-7182-493a-a9c4-5e6f708192a3' as Uuid4,
      amendment_kind: 'BILLING',
      sequence: 1,
      original_package_index_sha256: PACKAGE_INDEX_SHA256 as Sha256Hex,
      parent_amendment_index_sha256: null,
      payload: [
        { path: AMENDMENT_PATHS.billingImport, bytes: serializeRecordFile(record) },
        { path: `${AMENDMENT_PATHS.billingExportDirectory}export-00001.csv`, bytes: exportBytes },
      ],
      created_at: '2026-11-04T09:00:01.000Z' as UtcMillis,
    });
    assert.ok(amendment.ok, JSON.stringify(amendment));
    assert.deepEqual(
      amendment.value.index.entries.map((entry) => [
        entry.artifact_path,
        entry.artifact_class,
        entry.derivation,
        entry.sha256,
      ]),
      [
        [
          'payload/billing-export/export-00001.csv',
          'billing_export_file',
          'primary',
          record.billing_export.export_sha256,
        ],
        ['payload/billing-import.json', 'billing_import', 'derived', sha256(serializeRecordFile(record))],
      ],
    );
  });
});

describe('buildBillingImport refuses unusable inputs', () => {
  it('reports every invalid scalar and context problem together', () => {
    const input = runImport(ONE_LINE, {
      context: { ...RUN_CONTEXT, account_id: 'acct' },
      execution_manifest_sha256: 'A'.repeat(64),
      original_package_index_sha256: 'b'.repeat(63),
      ceiling_usd: '5,00',
      imported_at: '2026-11-04T09:00:00Z',
    });
    assert.deepEqual(refusals(input), [
      ['INVALID_ATTRIBUTION_CONTEXT', 'account_id "acct" is not a 12-digit account id'],
      ['INVALID_BILLING_IMPORT_INPUT', `execution_manifest_sha256 "${'A'.repeat(64)}" is not a sha256`],
      ['INVALID_BILLING_IMPORT_INPUT', `original_package_index_sha256 "${'b'.repeat(63)}" is not a sha256`],
      ['INVALID_BILLING_IMPORT_INPUT', 'ceiling_usd "5,00" is not a money decimal'],
      ['INVALID_BILLING_IMPORT_INPUT', 'imported_at "2026-11-04T09:00:00Z" is not UTC millis'],
    ]);
  });

  it('reports each invalid scalar on its own', () => {
    const cases: readonly [Partial<BillingImportInput>, string][] = [
      [{ execution_manifest_sha256: '' }, 'execution_manifest_sha256 "" is not a sha256'],
      [{ original_package_index_sha256: '' }, 'original_package_index_sha256 "" is not a sha256'],
      [{ ceiling_usd: '-5' }, 'ceiling_usd "-5" is not a money decimal'],
      [{ imported_at: '' }, 'imported_at "" is not UTC millis'],
    ];
    for (const [override, problem] of cases) {
      assert.deepEqual(refusals(runImport(ONE_LINE, override)), [['INVALID_BILLING_IMPORT_INPUT', problem]]);
    }
    assert.deepEqual(refusals(runImport(ONE_LINE, { context: { ...RUN_CONTEXT, account_id: '' } })), [
      ['INVALID_ATTRIBUTION_CONTEXT', 'account_id "" is not a 12-digit account id'],
    ]);
  });

  it('refuses an export that is not readable CSV', () => {
    assert.deepEqual(refusals(runImport(csvBytes('a,"b\n'))), [
      ['CUR_EXPORT_MALFORMED', 'record 1: quote opened at character 2 is never closed'],
    ]);
  });

  it('refuses an export whose billing period cannot be read', () => {
    assert.deepEqual(refusals(runImport(csvBytes(curCsv([])))), [
      ['CUR_EXPORT_PERIOD_UNREADABLE', 'the export names 0 period start(s) and 0 end(s)'],
    ]);
  });
});
