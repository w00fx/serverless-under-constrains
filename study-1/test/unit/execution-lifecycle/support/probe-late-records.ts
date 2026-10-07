// Late stream lines of a transport probe, built from the record contract's canonical examples moved
// to the probe's scope: the probe's id instead of the run's, and no trial (the probe has none,
// D-06). Each builder returns parsed JSON, as a reader of the stream sees it.

import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import type { RawArtifact } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue, Sha256Hex, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { LateEvidenceSource } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { EXECUTION_MANIFEST_SHA256, PROBE_ID, toJson } from '../../../support/record-contract/record-builders.ts';

/** The probe every line below belongs to. */
export const PROBE_CONTEXT: { readonly transport_probe_id: Uuid4; readonly execution_manifest_sha256: Sha256Hex } = {
  transport_probe_id: PROBE_ID,
  execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
};

/** The instant every line was captured at. */
export const CAPTURED_AT = '2026-10-05T12:45:00.000Z';

/**
 * A canonical example record as the probe would have written it.
 *
 * @example
 * probeScoped(providerCallReceived()); // transport_probe_id, no run_id, no trial pair
 */
export function probeScoped(record: StudyRecord): JsonObject {
  const { run_id: _run, trial_id: _trial, trial_manifest_sha256: _digest, ...rest } = toJson(record);
  return { ...rest, transport_probe_id: PROBE_ID };
}

/** What one probe late line says, beyond its envelope. */
export interface ProbeLateLine {
  readonly sequence: number;
  readonly late_source: LateEvidenceSource;
  readonly late_record: JsonObject;
  readonly correlated?: boolean;
  readonly late_record_type?: string;
}

/**
 * One `late_evidence_record` line of the probe.
 *
 * @example
 * probeLateLine({ sequence: 1, late_source: 'PROVIDER_JOURNAL', late_record: probeScoped(providerCallReceived()) });
 */
export function probeLateLine(line: ProbeLateLine): JsonObject {
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    ...PROBE_CONTEXT,
    sequence: line.sequence,
    captured_at: CAPTURED_AT,
    late_source: line.late_source,
    correlated: line.correlated ?? true,
    late_record_type: line.late_record_type ?? recordTypeOf(line.late_record),
    late_record: line.late_record,
  };
}

function recordTypeOf(record: JsonObject): string {
  const type = record['record_type'];
  return typeof type === 'string' ? type : JSON.stringify(type ?? null);
}

/**
 * The late stream holding these lines, each canonical JSON terminated by a newline.
 *
 * @example
 * probeStream([probeLateLine({ ... })]).path; // 'late-evidence/late-evidence-stream.jsonl'
 */
export function probeStream(lines: readonly JsonValue[]): RawArtifact {
  return probeStreamText(lines.map((line) => `${canonicalJson(line)}\n`).join(''));
}

/**
 * The late stream holding exactly this text.
 *
 * @example
 * probeStreamText('{"not":"closed"'); // a truncated stream
 */
export function probeStreamText(text: string): RawArtifact {
  return { path: EXECUTION_PATHS.lateEvidenceStream, bytes: new TextEncoder().encode(text) };
}
