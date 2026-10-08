// FakeProbePackageReader (design §12.2, named FakeQualificationVerifier there): the probe-package
// port over in-memory stored packages. It emulates `StoredProbePackageReader`: a stored probe
// reads as its original package files, its amendment directories, exactly the selection's
// amendment head and the clock's evaluation instant; an unknown probe fails with the evidence
// file system's NOT_FOUND. Verification and usability stay production code (A10 runs them over
// what this returns). Its conformance test writes the same package into a memory evidence root
// and compares both readers' results.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Uuid4, WallClock } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import type { AmendmentSnapshot } from '../../../src/evidence-package/amendment-snapshots.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type {
  PortFailure,
  PortResult,
  ProbePackageReadPort,
  QualificationSelection,
} from '../../../src/admission/admission-ports.ts';
import type { ProbePackageInput } from '../../../src/transport-qualification/verdict/probe-usability-reader.ts';

interface StoredProbe {
  readonly files: readonly PackageFile[];
  readonly amendments: readonly AmendmentSnapshot[];
}

/**
 * Stored probe packages, read by selection.
 *
 * @example
 * const packages = new FakeProbePackageReader(clock);
 * packages.store(probeId, files);
 * await packages.readProbePackage({ transport_probe_id: probeId, original_package_index_sha256, amendment_head_sha256: null });
 */
export class FakeProbePackageReader implements ProbePackageReadPort {
  readonly #clock: WallClock;
  readonly #stored = new Map<string, StoredProbe>();
  readonly #selections: QualificationSelection[] = [];
  #failure: PortFailure | undefined;

  constructor(clock: WallClock) {
    this.#clock = clock;
  }

  /** Stores (or replaces) one probe's original package and its amendment directories. */
  store(probeId: Uuid4, files: readonly PackageFile[], amendments: readonly AmendmentSnapshot[] = []): void {
    this.#stored.set(probeId, { files, amendments });
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  /** Every selection read so far. */
  selections(): readonly QualificationSelection[] {
    return [...this.#selections];
  }

  readProbePackage(selection: QualificationSelection): PortResult<ProbePackageInput> {
    this.#selections.push(selection);
    const identity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: selection.transport_probe_id } as const;
    const stored = this.#stored.get(selection.transport_probe_id);
    if (this.#failure !== undefined || stored === undefined) {
      const directory = PACKAGE_LAYOUT.executionDirectory(identity);
      return Promise.resolve(
        err(this.#failure ?? { code: 'NOT_FOUND', detail: `${JSON.stringify(directory)}: ENOENT` }),
      );
    }
    return Promise.resolve(
      ok({
        identity,
        original: { files: stored.files, special_entries: [] },
        amendments: stored.amendments,
        selected_head: selection.amendment_head_sha256,
        referenced_package_indexes: [],
        evaluated_at: formatUtcMillis(this.#clock.now()),
      }),
    );
  }
}
