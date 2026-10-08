// Finding one amendment of a verified selected chain among the amendment directories: an amendment
// is known only by the digest of its `amendment-index.json` bytes (design §8.16 step 6), so a
// directory whose index is absent cannot be the one a chain link names.

import type { Sha256Hex } from '../record-contract/primitives.ts';
import type { AmendmentSnapshot } from '../evidence-package/amendment-snapshots.ts';
import { fileAt } from '../evidence-package/index-entries.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';

/**
 * The amendment whose index bytes hash to `indexDigest`, or `undefined` when none does.
 *
 * @example
 * selectedAmendment(link.amendment_index_sha256, amendments, sha256Hex)?.files;
 */
export function selectedAmendment(
  indexDigest: Sha256Hex,
  amendments: readonly AmendmentSnapshot[],
  digest: ByteDigest,
): AmendmentSnapshot | undefined {
  return amendments.find((snapshot) => {
    const index = fileAt(snapshot.files, AMENDMENT_PATHS.amendmentIndex);
    return index !== undefined && digest(index.bytes) === indexDigest;
  });
}
