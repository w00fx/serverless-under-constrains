// Reading a canonical run package back (design §7, §8.14; A-05): only a missing, unreadable or
// non-RUN execution manifest stops the read; any other file that cannot be read, or that names
// another execution or trial, is reported and treated as absent.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { readRunPackage } from '../../../src/study-comparison/run-package-reader.ts';
import type { RunPackageRecords } from '../../../src/study-comparison/run-package-reader.ts';
import type { FixtureBytes } from '../../support/golden-builder/digest-links.ts';
import {
  READ_DEPS,
  cleanRunFiles,
  editJson,
  editJsonl,
  probeManifestBytes,
  storedDigest,
  trialFile,
  withBytes,
  withoutFile,
} from './support/clean-run.ts';

const OTHER_MANIFEST = 'd'.repeat(64);
let files: FixtureBytes;

before(async () => {
  files = await cleanRunFiles();
});

function read(packageFiles: FixtureBytes): RunPackageRecords {
  const result = readRunPackage(packageFiles, READ_DEPS);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.error));
  return result.value;
}

function reasonsOf(records: RunPackageRecords): readonly string[] {
  return records.reasons.map((reason) => `${reason.code} ${reason.artifact_path ?? ''}`);
}

describe('readRunPackage', () => {
  it('reads every record of a clean finalized run with no reason', () => {
    const records = read(files);
    assert.deepEqual(records.reasons, []);
    assert.equal(records.run_id, records.execution_manifest.record.run_id);
    assert.equal(
      records.execution_manifest.ref.artifact_sha256,
      storedDigest(files, EXECUTION_PATHS.executionManifest),
    );
    for (const trial of records.trial_records) {
      assert.ok(
        trial.trial_manifest &&
          trial.provider_configuration &&
          trial.payment &&
          trial.approved_decision &&
          trial.oracle_result,
      );
      assert.equal(trial.oracle_result.record.trial_id, trial.trial.trial_id);
    }
    for (const frozen of [
      records.resource_manifest,
      records.source_provenance,
      records.late_evidence,
      records.cleanup,
      records.leak_audit,
      records.safety,
      records.comparison_assessment,
      records.run_summary,
    ]) {
      assert.ok(frozen !== undefined);
    }
    assert.ok(records.runner_events.length > 0);
    assert.ok(records.lease_events.length > 0);
  });

  it('fails without an execution manifest', () => {
    const result = readRunPackage(withoutFile(files, EXECUTION_PATHS.executionManifest), READ_DEPS);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.error.map(({ code, subject }) => [code, subject]),
      [['ARTIFACT_MISSING', 'execution_manifest']],
    );
  });

  it('fails with an unreadable execution manifest', () => {
    const result = readRunPackage(
      withBytes(files, EXECUTION_PATHS.executionManifest, new Uint8Array([0xc3])),
      READ_DEPS,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.error.map(({ code }) => code),
      ['ARTIFACT_UNREADABLE'],
    );
  });

  it('fails for a manifest of another execution kind', () => {
    const result = readRunPackage(withBytes(files, EXECUTION_PATHS.executionManifest, probeManifestBytes()), READ_DEPS);
    assert.equal(result.ok, false);
    assert.match(
      result.error.map((reason) => reason.detail).join('\n'),
      /has execution_kind TRANSPORT_PROBE; expected RUN$/,
    );
  });

  it('reports an unreadable record and treats it as absent', () => {
    const records = read(withBytes(files, EXECUTION_PATHS.cleanupResult, new TextEncoder().encode('[]')));
    assert.equal(records.cleanup, undefined);
    assert.deepEqual(reasonsOf(records), [`ARTIFACT_UNREADABLE ${EXECUTION_PATHS.cleanupResult}`]);
  });

  it('reports an uncorrelated record that cannot be read', () => {
    const records = read(withBytes(files, EXECUTION_PATHS.sourceProvenance, new TextEncoder().encode('{}')));
    assert.equal(records.source_provenance, undefined);
    assert.deepEqual(reasonsOf(records), [`ARTIFACT_UNREADABLE ${EXECUTION_PATHS.sourceProvenance}`]);
  });

  it('treats a record of another execution as absent', () => {
    const edited = editJson(files, EXECUTION_PATHS.leakAuditResult, (record) => ({
      ...record,
      execution_manifest_sha256: OTHER_MANIFEST,
    }));
    const records = read(edited);
    assert.equal(records.leak_audit, undefined);
    assert.equal(records.reasons.length, 1);
    assert.match(
      records.reasons[0]?.detail ?? '',
      new RegExp(`names execution_manifest_sha256 ${OTHER_MANIFEST}; expected [0-9a-f]{64}$`),
    );
  });

  it('treats a trial record stored under another trial as absent', () => {
    const clean = read(files);
    const [first, second] = clean.trial_records;
    const source = files.get(trialFile(second.trial.trial_id, 'oracleResult'));
    assert.ok(source !== undefined);
    const records = read(withBytes(files, trialFile(first.trial.trial_id, 'oracleResult'), source));
    assert.equal(records.trial_records[0].oracle_result, undefined);
    assert.ok(records.trial_records[1].oracle_result !== undefined);
    assert.match(
      records.reasons[0]?.detail ?? '',
      new RegExp(`names trial ${second.trial.trial_id}; expected ${first.trial.trial_id}$`),
    );
  });

  it('keeps absent trial inputs absent without a reason', () => {
    const trialId = read(files).trial_records[2].trial.trial_id;
    const records = read(
      withoutFile(withoutFile(files, trialFile(trialId, 'payment')), trialFile(trialId, 'trialManifest')),
    );
    assert.equal(records.trial_records[2].payment, undefined);
    assert.equal(records.trial_records[2].trial_manifest, undefined);
    assert.deepEqual(records.reasons, []);
  });

  it('drops journal events of another execution and reports each', () => {
    const edited = editJsonl(files, EXECUTION_PATHS.coordinationJournal, (lines) =>
      lines.map((line, index) => (index === 0 ? { ...line, execution_manifest_sha256: OTHER_MANIFEST } : line)),
    );
    const records = read(edited);
    assert.equal(records.lease_events.length, read(files).lease_events.length - 1);
    assert.deepEqual(reasonsOf(records), [`ARTIFACT_UNREADABLE ${EXECUTION_PATHS.coordinationJournal}`]);
  });

  it('collects unreadable journal lines', () => {
    const runner = files.get(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array();
    const records = read(withBytes(files, EXECUTION_PATHS.runnerJournal, new Uint8Array([...runner, 0x7b, 0x0a])));
    assert.equal(records.runner_events.length, read(files).runner_events.length);
    assert.deepEqual(reasonsOf(records), [`ARTIFACT_UNREADABLE ${EXECUTION_PATHS.runnerJournal}`]);
  });
});
