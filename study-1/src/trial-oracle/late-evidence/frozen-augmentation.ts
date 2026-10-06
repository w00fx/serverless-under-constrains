// The frozen evidence of one trial plus its late records (BR-RUA-043, design §8.13): the input a
// reassessment ingests. A late journal event or queue observation is one more line of its file; a
// re-captured document is folded into its frozen copy. Everything is built anew: the frozen input,
// its bytes and its index digests are only read (AC-RUA-030 "never modifies frozen results or
// digests"). A re-evaluated package checks each file against its evidence index; a file the late
// records extend is no longer the indexed file, so its index entry is set aside, unless the frozen
// bytes already disagreed with it, in which case the disagreement the frozen result saw is kept.

import type { IngestionInput, RawArtifact } from '../../evidence-ingestion/ingestion-model.ts';
import { canonicalJson } from '../../record-contract/canonical-json.ts';
import { sha256Hex } from '../../record-contract/digests.ts';
import type { Sha256Hex } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import { foldLateDocument } from './document-folding.ts';
import type { LateProblem } from './late-evidence-reasons.ts';
import type { AcceptedLateRecord } from './late-stream-reading.ts';

export interface FrozenAugmentation {
  readonly input: IngestionInput;
  readonly problems: readonly LateProblem[];
}

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

/**
 * The trial's frozen evidence with every given late record joined at its route. A record that
 * cannot join its frozen file is a problem and is left out.
 *
 * @example
 * const augmented = augmentFrozenEvidence(frozenInput, lateRecords, validator);
 * ingestEvidence(augmented.input, validator); // the frozen evidence plus the late evidence
 */
export function augmentFrozenEvidence(
  frozen: IngestionInput,
  records: readonly AcceptedLateRecord[],
  validator: RecordValidator,
): FrozenAugmentation {
  const original = new Map(frozen.artifacts.map((artifact) => [artifact.path, artifact.bytes] as const));
  const changed = new Map<string, Uint8Array>();
  const problems: LateProblem[] = [];
  for (const accepted of records) {
    const path = accepted.route.path;
    const joined = joinLateRecord(accepted, changed.get(path) ?? original.get(path), validator);
    if (joined.ok) {
      changed.set(path, joined.value);
    } else {
      problems.push({ code: 'LATE_DOCUMENT_UNFOLDABLE', artifact_path: path, detail: joined.error });
    }
  }
  const artifacts: RawArtifact[] = frozen.artifacts.map((artifact) => ({
    path: artifact.path,
    bytes: changed.get(artifact.path) ?? artifact.bytes,
  }));
  for (const [path, bytes] of changed) {
    if (!original.has(path)) {
      artifacts.push({ path, bytes });
    }
  }
  const indexed = frozen.indexed_digests;
  const input: IngestionInput = {
    artifacts,
    expected: frozen.expected,
    execution_scope_artifacts: frozen.execution_scope_artifacts,
    ...(indexed === undefined ? {} : { indexed_digests: setAsideExtended(indexed, original, changed) }),
  };
  return { input, problems };
}

type Joined = { readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly error: string };

function joinLateRecord(
  accepted: AcceptedLateRecord,
  current: Uint8Array | undefined,
  validator: RecordValidator,
): Joined {
  const { route, record, line_number: lineNumber } = accepted;
  const at = `late stream line ${String(lineNumber)}`;
  if (route.fold !== 'append_line') {
    const folded = foldLateDocument(route.fold, current, record.late_record, validator);
    return folded.ok ? folded : { ok: false, error: `${at}: ${folded.error}` };
  }
  const existing = current ?? new Uint8Array();
  if (existing.length > 0 && existing[existing.length - 1] !== NEWLINE) {
    return {
      ok: false,
      error: `${at}: the frozen file ends without a newline; expected complete JSONL lines to append to`,
    };
  }
  const line = encoder.encode(`${canonicalJson(record.late_record)}\n`);
  const appended = new Uint8Array(existing.length + line.length);
  appended.set(existing);
  appended.set(line, existing.length);
  return { ok: true, value: appended };
}

function setAsideExtended(
  indexed: ReadonlyMap<string, Sha256Hex>,
  original: ReadonlyMap<string, Uint8Array>,
  changed: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Sha256Hex> {
  return new Map(
    [...indexed].filter(([path, digest]) => {
      const frozenBytes = original.get(path);
      return !changed.has(path) || frozenBytes === undefined || sha256Hex(frozenBytes) !== digest;
    }),
  );
}
