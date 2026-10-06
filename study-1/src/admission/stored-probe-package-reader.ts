// The selected probe's stored evidence, read through the write-once evidence file system
// (BR-RUA-028, design §8.16, §10.1 A10): the original package of `transport-probes/<id>/`, every
// amendment directory found for it, and the operator's explicit amendment head. Nothing is
// selected implicitly: the head is exactly the request's, and the verifier judges the chain.

import { readAmendmentSnapshots, readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { WallClock } from '../record-contract/primitives.ts';
import type { ProbePackageReadPort, QualificationSelection } from './admission-ports.ts';

/**
 * The probe-package port over the evidence root.
 *
 * @example
 * const packages = new StoredProbePackageReader(evidenceFiles, clock);
 * await packages.readProbePackage(selection); // { ok: true, value: { identity, original, amendments, … } }
 */
export class StoredProbePackageReader implements ProbePackageReadPort {
  readonly #fs: PackageFileSystem;
  readonly #clock: WallClock;

  constructor(fs: PackageFileSystem, clock: WallClock) {
    this.#fs = fs;
    this.#clock = clock;
  }

  async readProbePackage(selection: QualificationSelection): ReturnType<ProbePackageReadPort['readProbePackage']> {
    const identity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: selection.transport_probe_id } as const;
    const original = await readPackageSnapshot(this.#fs, identity);
    if (!original.ok) {
      return original;
    }
    const amendments = await readAmendmentSnapshots(this.#fs, identity);
    if (!amendments.ok) {
      return amendments;
    }
    return {
      ok: true,
      value: {
        identity,
        original: original.value,
        amendments: amendments.value,
        selected_head: selection.amendment_head_sha256,
        referenced_package_indexes: [],
        evaluated_at: formatUtcMillis(this.#clock.now()),
      },
    };
  }
}
