// Offline stand-in for the execution runner's P5 checkpoint of the coordination journal (design §7,
// §10.2 P5; BR-RUA-044; `CoordinationCheckpointWriter`): it reads the coordination journal the
// lease is still appending to, builds the checkpoint of its complete-line prefix with the
// production builder and writes `coordination/coordination-prefix-checkpoint.json` once. The
// execution runner (CMP-05) binds the production writer the same way over its own journal.
//
// Test hook: `refuseNext(reason)` makes the next checkpoint fail with `reason`, writing nothing.

import { buildPrefixCheckpoint } from '../../../src/evidence-package/prefix-checkpoint.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { Sha256Hex, StructuredReason, Uuid4, WallClock } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import type { CoordinationCheckpointWriter } from '../../../src/trial-execution/trial-execution-ports.ts';

/** The probe package the checkpoint belongs to. */
export interface CheckpointedProbe {
  readonly package_directory: string;
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
}

export class OfflineCoordinationCheckpointer implements CoordinationCheckpointWriter {
  readonly #files: PackageFileSystem;
  readonly #probe: CheckpointedProbe;
  readonly #clock: WallClock;
  #refusal: StructuredReason | undefined;

  constructor(files: PackageFileSystem, probe: CheckpointedProbe, clock: WallClock) {
    this.#files = files;
    this.#probe = probe;
    this.#clock = clock;
  }

  async writeCheckpoint(): Promise<StructuredReason | undefined> {
    const refusal = this.#refusal;
    this.#refusal = undefined;
    if (refusal !== undefined) {
      return refusal;
    }
    const directory = this.#probe.package_directory;
    const journal = await this.#files.read(`${directory}/${EXECUTION_PATHS.coordinationJournal}`);
    if (!journal.ok) {
      return checkpointReason(`the coordination journal is unreadable (${journal.error.code})`);
    }
    const checkpoint = buildPrefixCheckpoint({
      journal: journal.value,
      transport_probe_id: this.#probe.transport_probe_id,
      execution_manifest_sha256: this.#probe.execution_manifest_sha256,
      checkpointed_at: formatUtcMillis(this.#clock.now()),
    });
    if (!checkpoint.ok) {
      return checkpoint.error;
    }
    const path = `${directory}/${EXECUTION_PATHS.coordinationPrefixCheckpoint}`;
    const written = await this.#files.writeOnce(path, serializeRecordFile(checkpoint.value));
    return written.ok ? undefined : checkpointReason(`${path} was not written (${written.error.code})`);
  }

  /** The next checkpoint fails with `reason` and writes nothing. */
  refuseNext(reason: StructuredReason): void {
    this.#refusal = reason;
  }
}

function checkpointReason(problem: string): StructuredReason {
  return {
    code: 'COORDINATION_CHECKPOINT_NOT_WRITTEN',
    subject: 'BR-RUA-044',
    detail: `${problem}; expected the coordination prefix checkpoint at transport freeze`,
  };
}
