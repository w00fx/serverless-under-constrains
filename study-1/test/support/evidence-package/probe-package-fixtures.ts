// A complete, eligible transport-probe package built with the production builders, and amendment
// chains on top of it, for the verifier tests. Every digest a package records about itself is real:
// the deployment-assembly inventory, the coordination prefix checkpoint (taken while the journal was
// still open), the probe evidence index, the references of the derived records and the final
// package index. A test changes one thing and reads which reason the verifier gives.

import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { ExecutionIdentity, Result, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type {
  OperationalClosure,
  OperationalRecoveryRecord,
} from '../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { TransportProbeSummary } from '../../../src/record-contract/records/group-c/transport_probe_summary.ts';
import type { AmendmentKind, CleanupStatus } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { buildAmendment } from '../../../src/evidence-package/amendments.ts';
import type { AmendmentSnapshot } from '../../../src/evidence-package/amendment-snapshots.ts';
import { inventoryAssembly } from '../../../src/evidence-package/assembly-inventory.ts';
import { buildEvidenceIndex } from '../../../src/evidence-package/evidence-index.ts';
import { buildPackageIndex } from '../../../src/evidence-package/package-index.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { PackageVerificationInput } from '../../../src/evidence-package/package-verifier.ts';
import { buildPrefixCheckpoint } from '../../../src/evidence-package/prefix-checkpoint.ts';
import { PROBE_ID, at, uuid } from '../record-contract/record-builders.ts';

export const PROBE_IDENTITY: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID };
export const FIXTURE_VALIDATOR: RecordValidator = createRecordValidator();
export const FIXTURE_DEPS = { validator: FIXTURE_VALIDATOR, digest: sha256Hex } as const;

export const PROBE_PATHS = {
  callerJournal: 'probe/journals/caller-journal.jsonl',
  ledgerSnapshot: 'probe/ledger/ledger-snapshot.json',
  probeResult: 'probe/derived/transport-probe-result.json',
  evidenceIndex: 'probe/evidence-index.json',
  assemblyManifest: 'admission/deployment-assembly/manifest.json',
  assemblyBundle: 'admission/deployment-assembly/asset.0001/index.mjs',
} as const;

export const CALLER_EVENT_ID = uuid(0x910);
const COORDINATION_EVENTS = [uuid(0x900), uuid(0x901)] as const;
const encoder = new TextEncoder();

export interface ProbePackage {
  readonly identity: ExecutionIdentity;
  readonly files: readonly PackageFile[];
  readonly index_sha256: Sha256Hex;
  readonly manifest_sha256: Sha256Hex;
}

export interface ProbePackageOptions {
  readonly cleanup_status?: CleanupStatus;
}

/**
 * Builds the eligible probe package.
 *
 * @example
 * const fixture = probePackage();
 * verifyPackage(verificationInput(fixture, [], null), FIXTURE_DEPS).package_eligibility; // 'eligible'
 */
export function probePackage(options: ProbePackageOptions = {}): ProbePackage {
  const manifest = jsonFile(EXECUTION_PATHS.executionManifest, { manifest: 'transport probe fixture' });
  const manifestDigest = sha256Hex(manifest.bytes);
  const journalPrefix = jsonLines([coordinationEvent(0), coordinationEvent(1)].slice(0, 1));
  const frozen: PackageFile[] = [
    manifest,
    jsonFile(EXECUTION_PATHS.environmentInput, { region: 'us-east-1' }),
    jsonFile(EXECUTION_PATHS.sourceProvenance, { commit: 'fixture' }),
    jsonFile(EXECUTION_PATHS.oracleRevisionCheck, { revision: 'fixture' }),
    jsonFile(EXECUTION_PATHS.resourceManifest, { resources: [] }),
    ...assemblyFiles(),
    { path: EXECUTION_PATHS.coordinationPrefixCheckpoint, bytes: checkpointBytes(journalPrefix, manifestDigest) },
    {
      path: PROBE_PATHS.callerJournal,
      bytes: jsonLines([{ event_id: CALLER_EVENT_ID, source_sequence: 1, outcome: { status: 'accepted' } }]),
    },
    jsonFile(PROBE_PATHS.ledgerSnapshot, { balance: '100.00', refunds: [] }),
  ];
  frozen.push(jsonFile(PROBE_PATHS.probeResult, probeResult(frozen)));
  frozen.push({ path: PROBE_PATHS.evidenceIndex, bytes: evidenceIndexBytes(frozen) });
  const lateStream: PackageFile = { path: EXECUTION_PATHS.lateEvidenceStream, bytes: new Uint8Array() };
  const lateAssessment = jsonFile(EXECUTION_PATHS.lateEvidenceAssessment, {
    evidence_refs: [{ artifact_path: lateStream.path, artifact_sha256: sha256Hex(lateStream.bytes) }],
  });
  const files = [
    ...frozen,
    { path: EXECUTION_PATHS.coordinationJournal, bytes: jsonLines([coordinationEvent(0), coordinationEvent(1)]) },
    lateStream,
    lateAssessment,
    jsonRecord(EXECUTION_PATHS.transportProbeSummary, probeSummary(manifestDigest, lateAssessment, frozen, options)),
  ];
  return indexedProbePackage(files);
}

/**
 * Rebuilds the final package index over `files` (any old index dropped), as a writer that froze
 * these exact bytes would have.
 *
 * @example
 * const altered = indexedProbePackage(replaceFile(fixture.files, path, bytes));
 */
export function indexedProbePackage(files: readonly PackageFile[]): ProbePackage {
  const content = files.filter((file) => file.path !== EXECUTION_PATHS.packageIndex);
  const index = unwrap(buildPackageIndex({ files: content, identity: PROBE_IDENTITY, created_at: at(9000) }));
  const indexFile = jsonRecord(EXECUTION_PATHS.packageIndex, index);
  return {
    identity: PROBE_IDENTITY,
    files: [...content, indexFile],
    index_sha256: sha256Hex(indexFile.bytes),
    manifest_sha256: index.execution_manifest_sha256,
  };
}

/**
 * `files` with the file at `path` replaced by `bytes` (or added when absent).
 *
 * @example
 * replaceFile(fixture.files, 'probe/ledger/ledger-snapshot.json', encoder.encode('{}'));
 */
export function replaceFile(files: readonly PackageFile[], path: string, bytes: Uint8Array): readonly PackageFile[] {
  return [...files.filter((file) => file.path !== path), { path, bytes }];
}

/**
 * `files` without the file at `path`.
 *
 * @example
 * withoutFile(fixture.files, 'package-index.json');
 */
export function withoutFile(files: readonly PackageFile[], path: string): readonly PackageFile[] {
  return files.filter((file) => file.path !== path);
}

/** One amendment of a fixture chain and the digest of its index. */
export interface FixtureAmendment {
  readonly snapshot: AmendmentSnapshot;
  readonly index_sha256: Sha256Hex;
}

/** The payload of one amendment to build. */
export interface AmendmentSpec {
  readonly kind: AmendmentKind;
  readonly payload: readonly PackageFile[];
}

/**
 * Builds a linear, dense, digest-valid chain of amendments over the package, in `specs` order.
 *
 * @example
 * const [first] = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
 */
export function amendmentChain(fixture: ProbePackage, specs: readonly AmendmentSpec[]): readonly FixtureAmendment[] {
  const chain: FixtureAmendment[] = [];
  for (const [position, spec] of specs.entries()) {
    const built = unwrap(
      buildAmendment({
        identity: fixture.identity,
        execution_manifest_sha256: fixture.manifest_sha256,
        amendment_id: uuid(0xa00 + position),
        amendment_kind: spec.kind,
        sequence: position + 1,
        original_package_index_sha256: fixture.index_sha256,
        parent_amendment_index_sha256: chain.at(-1)?.index_sha256 ?? null,
        payload: spec.payload,
        created_at: at(10_000 + position),
      }),
    );
    const directory = built.directory.slice(built.directory.lastIndexOf('/') + 1);
    chain.push({
      snapshot: { directory, files: built.files, special_entries: [] },
      index_sha256: sha256Hex(serializeRecordFile(built.index)),
    });
  }
  return chain;
}

/**
 * The verifier input for a package, its amendments and a selected head.
 *
 * @example
 * verifyPackage(verificationInput(fixture, chain, chain.at(-1)?.index_sha256 ?? null), FIXTURE_DEPS);
 */
export function verificationInput(
  fixture: ProbePackage,
  amendments: readonly FixtureAmendment[],
  selectedHead: Sha256Hex | null,
): PackageVerificationInput {
  return {
    identity: fixture.identity,
    original: { files: fixture.files, special_entries: [] },
    amendments: amendments.map((amendment) => amendment.snapshot),
    selected_head: selectedHead,
    referenced_package_indexes: [],
    evaluated_at: at(20_000),
  };
}

/**
 * A late-evidence assessment payload with the given status.
 *
 * @example
 * lateEvidencePayload(fixture, 'contradictory');
 */
export function lateEvidencePayload(fixture: ProbePackage, status: 'consistent' | 'contradictory'): PackageFile {
  const result = fixture.files.find((file) => file.path === PROBE_PATHS.probeResult)?.bytes ?? new Uint8Array();
  const frozenResult = { artifact_path: PROBE_PATHS.probeResult, artifact_sha256: sha256Hex(result) };
  const changes =
    status === 'contradictory' ? [{ field: '/transport_probe_verdict', frozen: 'pass', reassessed: 'fail' }] : [];
  const assessment: LateEvidenceAssessment = {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: fixture.manifest_sha256,
    monitoring: 'complete',
    late_evidence_status: status,
    monitoring_started_at: at(7000),
    monitoring_ended_at: at(67_000),
    correlated_record_count: 1,
    reassessments: [{ frozen_result_ref: frozenResult, status, changes }],
    reasons: [],
    evidence_refs: [],
    assessed_at: at(67_100),
  };
  return jsonRecord(AMENDMENT_PATHS.lateEvidenceAssessment, assessment);
}

/**
 * An operational recovery payload from `original` to `recovered`.
 *
 * @example
 * recoveryPayload(fixture, PARTIAL_CLOSURE, CLEAN_CLOSURE);
 */
export function recoveryPayload(
  fixture: ProbePackage,
  original: OperationalClosure,
  recovered: OperationalClosure,
): PackageFile {
  const record: OperationalRecoveryRecord = {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: fixture.manifest_sha256,
    recovery_id: uuid(0x700),
    original_package_index_sha256: fixture.index_sha256,
    original_closure: original,
    recovered_closure: recovered,
    steps_run: [3, 4, 11],
    cleanup_result_ref: {
      artifact_path: AMENDMENT_PATHS.cleanupResult,
      artifact_sha256: sha256Hex(encoder.encode('cleanup')),
    },
    leak_audit_result_ref: {
      artifact_path: AMENDMENT_PATHS.leakAuditResult,
      artifact_sha256: sha256Hex(encoder.encode('audit')),
    },
    reasons: [],
    started_at: at(8000),
    completed_at: at(8500),
  };
  return jsonRecord(AMENDMENT_PATHS.operationalRecoveryRecord, record);
}

/**
 * A billing-import payload.
 *
 * @example
 * billingPayload();
 */
export function billingPayload(): PackageFile {
  return jsonFile(AMENDMENT_PATHS.billingImport, { billing: 'fixture' });
}

/** Unwraps a builder result in fixtures, where a failure is a fixture bug. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`fixture builder failed: ${JSON.stringify(result.error)}; expected a valid fixture`);
  }
  return result.value;
}

function coordinationEvent(position: 0 | 1): Readonly<Record<string, unknown>> {
  return { event_id: COORDINATION_EVENTS[position], source_sequence: position + 1, record_type: 'lease_heartbeat' };
}

function assemblyFiles(): readonly PackageFile[] {
  const relative: readonly PackageFile[] = [
    { path: 'manifest.json', bytes: encoder.encode('{"version":"48.0.0","artifacts":{}}\n') },
    {
      path: 'asset.0001/index.mjs',
      bytes: encoder.encode('export const handler = async () => ({ statusCode: 200 });\n'),
    },
  ];
  const inventory = unwrap(
    inventoryAssembly({
      assembly_path: 'admission/deployment-assembly',
      entries: [
        { path: 'asset.0001', type: 'directory', mode: 0o040755 },
        ...relative.map((file) => ({ path: file.path, type: 'file' as const, mode: 0o100644 })),
      ],
      files: relative,
      inventoried_at: at(1000),
    }),
  );
  return [
    ...relative.map((file) => ({ path: `admission/deployment-assembly/${file.path}`, bytes: file.bytes })),
    jsonRecord(EXECUTION_PATHS.deploymentAssemblyInventory, inventory),
  ];
}

function checkpointBytes(journalPrefix: Uint8Array, manifestDigest: Sha256Hex): Uint8Array {
  const checkpoint = unwrap(
    buildPrefixCheckpoint({
      journal: journalPrefix,
      transport_probe_id: PROBE_ID,
      execution_manifest_sha256: manifestDigest,
      checkpointed_at: at(5000),
    }),
  );
  return serializeRecordFile(checkpoint);
}

function probeResult(frozen: readonly PackageFile[]): Readonly<Record<string, unknown>> {
  const digestOf = (path: string): Sha256Hex =>
    sha256Hex(frozen.find((file) => file.path === path)?.bytes ?? new Uint8Array());
  return {
    record_type: 'transport_probe_result',
    transport_probe_verdict: 'pass',
    evidence_refs: [
      {
        artifact_path: PROBE_PATHS.callerJournal,
        artifact_sha256: digestOf(PROBE_PATHS.callerJournal),
        event_id: CALLER_EVENT_ID,
        json_pointer: '/outcome/status',
      },
      {
        artifact_path: PROBE_PATHS.ledgerSnapshot,
        artifact_sha256: digestOf(PROBE_PATHS.ledgerSnapshot),
        json_pointer: '/balance',
      },
    ],
  };
}

function evidenceIndexBytes(frozen: readonly PackageFile[]): Uint8Array {
  const index = unwrap(
    buildEvidenceIndex({
      files: frozen,
      target: { index_scope: 'PROBE', transport_probe_id: PROBE_ID },
      created_at: at(6000),
    }),
  );
  return serializeRecordFile(index);
}

function probeSummary(
  manifestDigest: Sha256Hex,
  lateAssessment: PackageFile,
  frozen: readonly PackageFile[],
  options: ProbePackageOptions,
): TransportProbeSummary {
  const result = frozen.find((file) => file.path === PROBE_PATHS.probeResult);
  return {
    schema_version: 1,
    record_type: 'transport_probe_summary',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: manifestDigest,
    probe_terminal_reason: 'COMPLETED',
    probe_result_sha256: sha256Hex(result?.bytes ?? new Uint8Array()),
    cleanup_status: options.cleanup_status ?? 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    late_evidence_status: 'none',
    late_evidence_assessment_ref: {
      artifact_path: lateAssessment.path,
      artifact_sha256: sha256Hex(lateAssessment.bytes),
    },
    created_at: at(8900),
  };
}

function jsonFile(path: string, value: unknown): PackageFile {
  return { path, bytes: encoder.encode(`${JSON.stringify(value)}\n`) };
}

function jsonRecord(path: string, record: Parameters<typeof serializeRecordFile>[0]): PackageFile {
  return { path, bytes: serializeRecordFile(record) };
}

function jsonLines(values: readonly unknown[]): Uint8Array {
  return encoder.encode(values.map((value) => `${JSON.stringify(value)}\n`).join(''));
}
