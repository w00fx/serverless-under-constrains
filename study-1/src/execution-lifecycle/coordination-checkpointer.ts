// P5 of a transport probe, the runner's part (design §7, §10.2 P5; BR-RUA-044): the probe's
// coordination journal stays open through cleanup (the lease keeps heartbeating), so at transport
// freeze the runner checkpoints its complete-line prefix with `buildPrefixCheckpoint` and writes
// `coordination/coordination-prefix-checkpoint.json` once. The probe freeze calls it after the
// transport probe result and before the probe evidence index, which hashes the checkpoint; the
// final package index hashes the complete journal. The call opens the PROBE_FREEZE phase in the
// runner journal, so whether P5 ran is evidence of its own.

import { buildPrefixCheckpoint } from '../evidence-package/prefix-checkpoint.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import type { Sha256Hex, StructuredReason, Uuid4, WallClock } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { CoordinationCheckpointWriter } from '../trial-execution/trial-execution-ports.ts';
import type { ExecutionPhaseJournal } from './execution-journal.ts';

/** The probe package the checkpoint belongs to, and where P5 is journaled. */
export interface CheckpointedProbe {
  readonly files: PackageFileSystem;
  /** `transport-probes/<id>`, below the evidence root. */
  readonly package_directory: string;
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly journal: ExecutionPhaseJournal;
  readonly clock: WallClock;
}

/**
 * The production coordination checkpoint of one probe.
 *
 * @example
 * const checkpoint = new CoordinationPrefixCheckpointer({ files, package_directory, transport_probe_id,
 *   execution_manifest_sha256, journal, clock });
 * await probeRunner.execute(plan, gate, checkpoint);
 * checkpoint.invoked(); // true once the probe freeze reached P5
 */
export class CoordinationPrefixCheckpointer implements CoordinationCheckpointWriter {
  readonly #probe: CheckpointedProbe;
  #invoked = false;

  constructor(probe: CheckpointedProbe) {
    this.#probe = probe;
  }

  /** Whether the probe freeze reached P5 and asked for the checkpoint. */
  invoked(): boolean {
    return this.#invoked;
  }

  async writeCheckpoint(): Promise<StructuredReason | undefined> {
    this.#invoked = true;
    const probe = this.#probe;
    await probe.journal.phase('PROBE_FREEZE', 'started');
    const journalPath = `${probe.package_directory}/${EXECUTION_PATHS.coordinationJournal}`;
    const journal = await probe.files.read(journalPath);
    if (!journal.ok) {
      return checkpointReason(
        `${EXECUTION_PATHS.coordinationJournal} is unreadable (${journal.error.code}: ${journal.error.detail})`,
      );
    }
    const checkpoint = buildPrefixCheckpoint({
      journal: journal.value,
      transport_probe_id: probe.transport_probe_id,
      execution_manifest_sha256: probe.execution_manifest_sha256,
      checkpointed_at: formatUtcMillis(probe.clock.now()),
    });
    if (!checkpoint.ok) {
      return checkpoint.error;
    }
    const path = `${probe.package_directory}/${EXECUTION_PATHS.coordinationPrefixCheckpoint}`;
    const written = await probe.files.writeOnce(path, serializeRecordFile(checkpoint.value));
    return written.ok
      ? undefined
      : checkpointReason(
          `${EXECUTION_PATHS.coordinationPrefixCheckpoint} was not written (${written.error.code}: ${written.error.detail})`,
        );
  }
}

function checkpointReason(problem: string): StructuredReason {
  return {
    code: 'COORDINATION_CHECKPOINT_NOT_WRITTEN',
    subject: 'BR-RUA-044',
    detail: `${problem}; expected the coordination prefix checkpoint at transport freeze`,
  };
}
