// Named fake of the selected-qualification reader (design §12.2): instead of reading and judging
// the selected probe package, it answers the qualification the selection names with a scripted
// transport-scope snapshot digest, or a scripted refusal. Its conformance test compares it with
// `StoredQualificationReader` over a stored usable probe package.

import type { QualificationSelection } from '../../../../src/admission/admission-ports.ts';
import type { PackageFileSystem } from '../../../../src/evidence-package/package-file-system.ts';
import type {
  QualificationReader,
  SelectedQualificationReading,
} from '../../../../src/operator-cli/run-completion-inputs.ts';
import type { Sha256Hex, StructuredReason } from '../../../../src/record-contract/primitives.ts';

export class ScriptedQualificationReader implements QualificationReader {
  readonly #snapshot: Sha256Hex | undefined;
  readonly #refusal: readonly StructuredReason[];
  /** Every selection read, in order. */
  readonly selections: QualificationSelection[] = [];

  /** Answers with `snapshot` as the stored scope snapshot, or with `refusal` when it is non-empty. */
  constructor(snapshot?: Sha256Hex, refusal: readonly StructuredReason[] = []) {
    this.#snapshot = snapshot;
    this.#refusal = refusal;
  }

  readSelected(selection: QualificationSelection, _files: PackageFileSystem): Promise<SelectedQualificationReading> {
    this.selections.push(selection);
    if (this.#refusal.length > 0 || this.#snapshot === undefined) {
      return Promise.resolve({ selected: undefined, reasons: this.#refusal });
    }
    const head = selection.amendment_head_sha256;
    return Promise.resolve({
      selected: {
        qualification: {
          transport_probe_id: selection.transport_probe_id,
          original_package_index_sha256: selection.original_package_index_sha256,
          ...(head === null ? {} : { amendment_head_sha256: head }),
        },
        transport_scope_snapshot_sha256: this.#snapshot,
      },
      reasons: [],
    });
  }
}
