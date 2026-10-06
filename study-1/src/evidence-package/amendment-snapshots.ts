// Reading amendment packages back for verification (design §8.16 step 6). An amendment is known by
// the digest of its `amendment-index.json` bytes; an amendment whose index is absent or is not a
// valid amendment index cannot vouch for its payload, and its payload must match the index byte
// for byte with nothing unindexed (`ALTERED_BYTES`, `UNINDEXED_FILE`).
//
// The final assessment of a selected chain decides `CONTRADICTORY_CHAIN` (BR-RUA-043: "a
// contradictory amendment blocks qualification or comparison until another immutable
// reassessment is explicitly selected"): the late-evidence assessment of the last LATE_EVIDENCE or
// REASSESSMENT amendment in the chain. An assessment that cannot be read cannot show the chain is
// noncontradictory, so it counts as contradictory (evidence/WP-13/decisions.md).

import type { PackageIneligibilityReason } from '../record-contract/records/group-c/package_verification.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { ParsedAmendment } from './amendment-chain.ts';
import { fileAt } from './index-entries.ts';
import { fileSetIntegrityReasons, ineligibility } from './package-integrity.ts';
import type { ByteDigest } from './package-integrity.ts';
import type { FsEntry, PackageFile } from './package-file-system.ts';
import { AMENDMENT_PATHS } from './package-layout.ts';
import { parsePackageRecord } from './package-records.ts';

/** One amendment directory as stored: its name and its entries, relative to it. */
export interface AmendmentSnapshot {
  /** The directory name below the execution's amendments directory, for example `0001-<amendment_id>`. */
  readonly directory: string;
  readonly files: readonly PackageFile[];
  /** Symlinks, devices and other non-regular entries found in it. */
  readonly special_entries: readonly FsEntry[];
}

/** The services amendment reading uses. */
export interface AmendmentReadDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

/** Amendments whose index parsed, and every integrity reason found while reading them. */
export interface ReadAmendments {
  readonly amendments: readonly ParsedAmendment[];
  readonly reasons: readonly PackageIneligibilityReason[];
}

/**
 * Parses each amendment's index and checks its payload against it.
 *
 * @example
 * const read = readAmendments('amendments/<id>', snapshots, { validator, digest: sha256Hex });
 */
export function readAmendments(
  amendmentsDirectory: string,
  snapshots: readonly AmendmentSnapshot[],
  deps: AmendmentReadDeps,
): ReadAmendments {
  const reads = snapshots.map((snapshot) =>
    readAmendment(`${amendmentsDirectory}/${snapshot.directory}/`, snapshot, deps),
  );
  // flatMap, not a spread push: one reason per unindexed or altered file can exceed the engine's
  // argument limit, and a spread push then throws RangeError (A-05 totality).
  return { amendments: reads.flatMap((read) => read.amendments), reasons: reads.flatMap((read) => read.reasons) };
}

function readAmendment(location: string, snapshot: AmendmentSnapshot, deps: AmendmentReadDeps): ReadAmendments {
  const indexPath = AMENDMENT_PATHS.amendmentIndex;
  const indexFile = fileAt(snapshot.files, indexPath);
  if (indexFile === undefined) {
    return {
      amendments: [],
      reasons: [
        ineligibility(
          'ALTERED_BYTES',
          `${location}${indexPath} is absent; expected the amendment index written last`,
          location,
        ),
      ],
    };
  }
  const index = parsePackageRecord(indexFile.bytes, 'amendment_index', deps.validator, indexPath);
  if (!index.ok) {
    return { amendments: [], reasons: [ineligibility('ALTERED_BYTES', `${location}${index.error.detail}`, location)] };
  }
  const reasons = fileSetIntegrityReasons(
    {
      location,
      entries: index.value.entries,
      files: snapshot.files,
      special_entries: snapshot.special_entries,
      unlisted: [indexPath],
    },
    deps.digest,
  );
  const amendment = { location, index: index.value, index_sha256: deps.digest(indexFile.bytes), files: snapshot.files };
  return { amendments: [amendment], reasons };
}

/**
 * `CONTRADICTORY_CHAIN` when the last late-evidence assessment of the selected chain is
 * contradictory or unreadable; nothing when the chain carries no assessment.
 *
 * @example
 * finalAssessmentReasons(graph.selected_chain, validator); // [] for a consistent reassessment
 */
export function finalAssessmentReasons(
  chain: readonly ParsedAmendment[],
  validator: RecordValidator,
): readonly PackageIneligibilityReason[] {
  const assessing = chain.filter(
    (amendment) =>
      amendment.index.amendment_kind === 'LATE_EVIDENCE' || amendment.index.amendment_kind === 'REASSESSMENT',
  );
  const last = assessing.at(-1);
  if (last === undefined) {
    return [];
  }
  const path = AMENDMENT_PATHS.lateEvidenceAssessment;
  const file = fileAt(last.files, path);
  const assessment =
    file === undefined ? undefined : parsePackageRecord(file.bytes, 'late_evidence_assessment', validator, path);
  if (!assessment?.ok) {
    const problem = assessment === undefined ? 'is absent' : `cannot be read (${assessment.error.detail})`;
    return [contradictory(last, `${path} ${problem}; expected a readable late-evidence assessment`)];
  }
  const status = assessment.value.late_evidence_status;
  return status === 'contradictory'
    ? [contradictory(last, `late_evidence_status is contradictory; expected a later reassessment selected over it`)]
    : [];
}

function contradictory(amendment: ParsedAmendment, detail: string): PackageIneligibilityReason {
  return ineligibility(
    'CONTRADICTORY_CHAIN',
    `${amendment.location}: the final assessment of the selected chain: ${detail}`,
    amendment.location,
  );
}
