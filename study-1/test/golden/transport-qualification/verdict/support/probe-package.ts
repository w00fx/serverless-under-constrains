// A stored transport-probe package for the usability goldens and units (design §7, §8.11, §8.16),
// built in memory with the production builders over a probe case's committed fixture: the frozen
// probe result (`buildProbeResult`), a late-evidence assessment and its stream, the transport-scope
// snapshot, the lifecycle summary naming the result's digest, and the final package index
// (`buildPackageIndex`). Each golden changes one spec-named fact through `ProbePackageVariation`
// and reads which usability row fails (evidence/WP-10/decisions.md: no `cases/` file can state a
// package-level fact, as the variant-validation goldens found).

import { buildAmendment } from '../../../../../src/evidence-package/amendments.ts';
import { buildPackageIndex } from '../../../../../src/evidence-package/package-index.ts';
import type { PackageFile } from '../../../../../src/evidence-package/package-file-system.ts';
import {
  AMENDMENT_PATHS,
  EXECUTION_PATHS,
  PACKAGE_LAYOUT,
} from '../../../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../../src/record-contract/digests.ts';
import type { Sha256Hex, UtcMillis, Uuid4 } from '../../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../../src/record-contract/records/index.ts';
import type { LateEvidenceAssessment } from '../../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type {
  AmendmentKind,
  LateEvidenceStatus,
} from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { TransportProbeSummary } from '../../../../../src/record-contract/records/group-c/transport_probe_summary.ts';
import type { ProbePackageInput } from '../../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { transportScopeSnapshot } from '../../../../contract/record-contract/group-a/support/admission-examples.ts';
import { frozenProbeResult } from './probe-golden.ts';

/** The base probe's id and manifest digest, as its committed fixture records them. */
export const PROBE_IDENTITY = {
  execution_kind: 'TRANSPORT_PROBE',
  transport_probe_id: '2559d5f6-ec95-4777-a74e-452fcfde7526' as Uuid4,
} as const;
/** The probe's evaluation instant, after its summary (12:30). */
export const USABILITY_ASSESSED_AT = '2026-10-05T12:40:00.000Z' as UtcMillis;

const SUMMARY_CREATED_AT = '2026-10-05T12:30:00.000Z' as UtcMillis;
const INDEX_CREATED_AT = '2026-10-05T12:31:00.000Z' as UtcMillis;

/** One spec-named change to the eligible, usable package. */
export interface ProbePackageVariation {
  /** Summary members the lifecycle recorded, over a clean completed probe. */
  readonly summary?: Partial<
    Pick<TransportProbeSummary, 'cleanup_status' | 'leak_audit_status' | 'lease_status' | 'safety_status'>
  > & { readonly probe_terminal_reason?: 'COMPLETED' | 'CLEANUP_INCOMPLETE' | 'LEAK_AUDIT_NOT_CLEAN' };
  /** The frozen late-evidence assessment's status, mirrored into the summary. */
  readonly late_evidence_status?: Exclude<LateEvidenceStatus, 'unverified'>;
  /** Leave `admission/transport-scope-snapshot.json` out of the package. */
  readonly without_scope_snapshot?: boolean;
  /** Change one byte of this file after the index froze it. */
  readonly altered_after_index?: string;
}

/** A built package, with what an amendment chain over it needs. */
export interface BuiltProbePackage {
  readonly files: readonly PackageFile[];
  readonly index_sha256: Sha256Hex;
  readonly manifest_sha256: Sha256Hex;
}

/**
 * Builds the probe's stored package over fixture files.
 *
 * @example
 * const built = probePackage(loaded.files, { late_evidence_status: 'contradictory' });
 */
export function probePackage(
  fixture: ReadonlyMap<string, Uint8Array>,
  variation: ProbePackageVariation = {},
): BuiltProbePackage {
  const evidence = [...fixture].map(([path, bytes]) => ({ path, bytes }));
  const manifest = evidence.find((file) => file.path === EXECUTION_PATHS.executionManifest);
  const manifestDigest = sha256Hex(manifest?.bytes ?? new Uint8Array());
  const result = recordFile(
    PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult'),
    frozenProbeResult(fixture),
  );
  const lateStream: PackageFile = { path: EXECUTION_PATHS.lateEvidenceStream, bytes: new Uint8Array() };
  const lateStatus = variation.late_evidence_status ?? 'none';
  const lateAssessment = recordFile(
    EXECUTION_PATHS.lateEvidenceAssessment,
    lateAssessmentRecord(manifestDigest, lateStatus, result),
  );
  const scope =
    variation.without_scope_snapshot === true
      ? []
      : [recordFile(EXECUTION_PATHS.transportScopeSnapshot, transportScopeSnapshot())];
  const summary = recordFile(
    EXECUTION_PATHS.transportProbeSummary,
    summaryRecord(manifestDigest, result, lateAssessment, lateStatus, variation),
  );
  const content = [...evidence, result, lateStream, lateAssessment, ...scope, summary];
  const index = buildPackageIndex({ files: content, identity: PROBE_IDENTITY, created_at: INDEX_CREATED_AT });
  if (!index.ok) {
    throw new Error(`the probe package index does not build: ${JSON.stringify(index.error)}; expected an index`);
  }
  const indexFile = recordFile(EXECUTION_PATHS.packageIndex, index.value);
  const stored = [...content, indexFile].map((file) =>
    file.path === variation.altered_after_index ? { path: file.path, bytes: flippedLastByte(file.bytes) } : file,
  );
  return { files: stored, index_sha256: sha256Hex(indexFile.bytes), manifest_sha256: manifestDigest };
}

/**
 * The reader's input for a built package, its amendments and the selected head.
 *
 * @example
 * readProbeUsabilityInput(packageInput(built), { validator, digest: sha256Hex });
 */
export function packageInput(
  built: BuiltProbePackage,
  amendments: readonly AmendmentDirectory[] = [],
  selectedHead: Sha256Hex | null = null,
): ProbePackageInput {
  return {
    identity: PROBE_IDENTITY,
    original: { files: built.files, special_entries: [] },
    amendments: amendments.map((amendment) => amendment.snapshot),
    selected_head: selectedHead,
    referenced_package_indexes: [],
    evaluated_at: USABILITY_ASSESSED_AT,
  };
}

/** One built amendment directory and the digest of its index. */
export interface AmendmentDirectory {
  readonly snapshot: {
    readonly directory: string;
    readonly files: readonly PackageFile[];
    readonly special_entries: readonly [];
  };
  readonly index_sha256: Sha256Hex;
}

/**
 * Builds a linear amendment chain over the package, one amendment per payload, in order.
 *
 * @example
 * const [billing] = amendmentChain(built, [{ kind: 'BILLING', payload: [billingFile] }]);
 */
export function amendmentChain(
  built: BuiltProbePackage,
  specs: readonly { readonly kind: AmendmentKind; readonly payload: readonly PackageFile[] }[],
): readonly AmendmentDirectory[] {
  const chain: AmendmentDirectory[] = [];
  for (const [position, spec] of specs.entries()) {
    const amendment = buildAmendment({
      identity: PROBE_IDENTITY,
      execution_manifest_sha256: built.manifest_sha256,
      amendment_id: `0f0e0d0c-0b0a-4908-8706-05040302010${String(position)}` as Uuid4,
      amendment_kind: spec.kind,
      sequence: position + 1,
      original_package_index_sha256: built.index_sha256,
      parent_amendment_index_sha256: chain.at(-1)?.index_sha256 ?? null,
      payload: spec.payload,
      created_at: `2026-10-05T13:0${String(position)}:00.000Z` as UtcMillis,
    });
    if (!amendment.ok) {
      throw new Error(`amendment ${String(position + 1)} does not build: ${JSON.stringify(amendment.error)}`);
    }
    chain.push({
      snapshot: {
        directory: amendment.value.directory.slice(amendment.value.directory.lastIndexOf('/') + 1),
        files: amendment.value.files,
        special_entries: [],
      },
      index_sha256: sha256Hex(serializeRecordFile(amendment.value.index)),
    });
  }
  return chain;
}

/**
 * A stored record file at a path.
 *
 * @example
 * recordFile(AMENDMENT_PATHS.billingImport, billingImport);
 */
export function recordFile(path: string, record: StudyRecord): PackageFile {
  return { path, bytes: serializeRecordFile(record) };
}

/** The amendment payload paths this support writes. */
export const PAYLOAD_PATHS = AMENDMENT_PATHS;

function lateAssessmentRecord(
  manifestDigest: Sha256Hex,
  status: Exclude<LateEvidenceStatus, 'unverified'>,
  result: PackageFile,
): LateEvidenceAssessment {
  const frozen = { artifact_path: result.path, artifact_sha256: sha256Hex(result.bytes) };
  const reassessed = status === 'contradictory' ? 'fail' : 'pass';
  return {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    transport_probe_id: PROBE_IDENTITY.transport_probe_id,
    execution_manifest_sha256: manifestDigest,
    monitoring: 'complete',
    late_evidence_status: status,
    monitoring_started_at: '2026-10-05T12:09:00.000Z' as UtcMillis,
    monitoring_ended_at: '2026-10-05T12:19:00.000Z' as UtcMillis,
    correlated_record_count: status === 'none' ? 0 : 1,
    reassessments: [
      {
        frozen_result_ref: frozen,
        status,
        changes: status === 'contradictory' ? [{ field: '/transport_probe_verdict', frozen: 'pass', reassessed }] : [],
      },
    ],
    reasons: [],
    evidence_refs: [],
    assessed_at: '2026-10-05T12:19:30.000Z' as UtcMillis,
  };
}

function summaryRecord(
  manifestDigest: Sha256Hex,
  result: PackageFile,
  lateAssessment: PackageFile,
  lateStatus: LateEvidenceStatus,
  variation: ProbePackageVariation,
): TransportProbeSummary {
  return {
    schema_version: 1,
    record_type: 'transport_probe_summary',
    transport_probe_id: PROBE_IDENTITY.transport_probe_id,
    execution_manifest_sha256: manifestDigest,
    probe_terminal_reason: 'COMPLETED',
    probe_result_sha256: sha256Hex(result.bytes),
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    late_evidence_status: lateStatus,
    late_evidence_assessment_ref: {
      artifact_path: lateAssessment.path,
      artifact_sha256: sha256Hex(lateAssessment.bytes),
    },
    created_at: SUMMARY_CREATED_AT,
    ...variation.summary,
  };
}

function flippedLastByte(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const last = copy.length - 1;
  copy[last] = (copy[last] ?? 0) ^ 0x01;
  return copy;
}
