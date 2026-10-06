// The two study-completion inputs that do not come from the run package (BR-RUA-054, design §8.14):
// - the billed-cost checks of the selected BILLING amendments: each one's `billing_import` must
//   read as a valid record of this original package, else it shows nothing (a breach is the only
//   value that changes completion, and an unreadable import cannot show one);
// - the transport qualification the operator selected (`--probe`, `--probe-index`,
//   `--probe-head`), judged exactly as admission judged it (A10): the probe package is read from the
//   evidence root, verified with the selected head and must be usable; its stored transport-scope
//   snapshot digest is what the run's manifest must have frozen. A selection that no longer
//   qualifies is reported and selects nothing, so completion names the mismatch.

import type { QualificationSelection } from '../admission/admission-ports.ts';
import { assessQualification } from '../admission/qualification-check.ts';
import type { SelectedProbe } from '../admission/qualification-check.ts';
import { StoredProbePackageReader } from '../admission/stored-probe-package-reader.ts';
import type { AmendmentSnapshot } from '../evidence-package/amendment-snapshots.ts';
import { fileAt } from '../evidence-package/index-entries.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { BillingImport } from '../record-contract/records/group-c/billing_import.ts';
import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { BilledCostCheck } from '../record-contract/records/group-c/vocabulary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { SelectedRunQualification } from '../study-comparison/study-provenance.ts';
import { usageReason } from './arg-parsing.ts';
import { parseDigest, parseDigestFlag } from './package-reading.ts';

/** The flags that name the selected qualification (design §11 `run admit`). */
export const SELECTION_FLAGS = { probe: 'probe', index: 'probe-index', head: 'probe-head' } as const;

/**
 * The billed-cost check of every selected BILLING amendment that reads as this package's import.
 *
 * @example
 * selectedBilledCostChecks(verification, amendments, validator); // ['within_limit']
 */
export function selectedBilledCostChecks(
  verification: PackageVerification,
  amendments: readonly AmendmentSnapshot[],
  validator: RecordValidator,
): readonly BilledCostCheck[] {
  const checks: BilledCostCheck[] = [];
  for (const link of verification.selected_chain.filter((candidate) => candidate.amendment_kind === 'BILLING')) {
    const billing = billingImportOf(link.amendment_index_sha256, amendments, validator);
    if (billing?.original_package_index_sha256 === verification.original_package_index_sha256) {
      checks.push(billing.billed_cost_check);
    }
  }
  return checks;
}

function billingImportOf(
  indexDigest: string,
  amendments: readonly AmendmentSnapshot[],
  validator: RecordValidator,
): BillingImport | undefined {
  const amendment = amendments.find(
    (snapshot) => sha256Hex(fileAt(snapshot.files, AMENDMENT_PATHS.amendmentIndex)?.bytes ?? NO_BYTES) === indexDigest,
  );
  const bytes = amendment === undefined ? undefined : fileAt(amendment.files, AMENDMENT_PATHS.billingImport)?.bytes;
  const parsed = bytes === undefined ? undefined : parseJsonDocument(bytes);
  if (parsed?.ok !== true) {
    return undefined;
  }
  const checked = validator.validateAs('billing_import', parsed.value);
  return checked.valid ? (checked.record as BillingImport) : undefined;
}

const NO_BYTES = new Uint8Array();

/**
 * The qualification selection the three flags name.
 *
 * @example
 * parseSelection(new Map([['probe', id], ['probe-index', sha]])); // { ok: true, value: { …, amendment_head_sha256: null } }
 */
export function parseSelection(flags: ReadonlyMap<string, string>): Result<QualificationSelection, StructuredReason> {
  const probe = flags.get(SELECTION_FLAGS.probe) ?? '';
  if (!isUuid4(probe)) {
    return err(usageReason(`--probe ${boundedJsonText(probe)} is not a probe id`, 'a lowercase UUIDv4'));
  }
  const index = parseDigest(SELECTION_FLAGS.index, flags.get(SELECTION_FLAGS.index) ?? '');
  if (!index.ok) {
    return index;
  }
  const head = parseDigestFlag(SELECTION_FLAGS.head, flags.get(SELECTION_FLAGS.head));
  if (!head.ok) {
    return head;
  }
  return ok({
    transport_probe_id: probe,
    original_package_index_sha256: index.value,
    amendment_head_sha256: head.value,
  });
}

/** What the selected qualification gives completion, and why it gives nothing when it does not hold. */
export interface SelectedQualificationReading {
  readonly selected: SelectedRunQualification | undefined;
  readonly reasons: readonly StructuredReason[];
}

/** Reads the operator's selected qualification from the evidence root. */
export interface QualificationReader {
  readSelected(selection: QualificationSelection, files: PackageFileSystem): Promise<SelectedQualificationReading>;
}

/**
 * Judges the selection as admission did (A10) and returns what completion compares with the manifest.
 *
 * @example
 * const reading = await new StoredQualificationReader(clock, validator).readSelected(selection, files);
 * reading.selected?.transport_scope_snapshot_sha256;
 */
export class StoredQualificationReader implements QualificationReader {
  readonly #clock: WallClock;
  readonly #validator: RecordValidator;

  constructor(clock: WallClock, validator: RecordValidator) {
    this.#clock = clock;
    this.#validator = validator;
  }

  async readSelected(
    selection: QualificationSelection,
    files: PackageFileSystem,
  ): Promise<SelectedQualificationReading> {
    const reading = await new StoredProbePackageReader(files, this.#clock).readProbePackage(selection);
    const verdict = assessQualification('RUN', selection, reading, this.#validator);
    if (!verdict.passed) {
      return { selected: undefined, reasons: verdict.reasons };
    }
    // A run's A10 verdict always carries the selected probe; only a probe's own verdict is `null`
    // (qualification-check.ts), so the value is widened and narrowed back rather than re-checked.
    const probe = verdict.value as unknown as SelectedProbe;
    const head = selection.amendment_head_sha256;
    return {
      selected: {
        qualification: {
          transport_probe_id: selection.transport_probe_id,
          original_package_index_sha256: selection.original_package_index_sha256,
          ...(head === null ? {} : { amendment_head_sha256: head }),
        },
        transport_scope_snapshot_sha256: probe.snapshot_sha256,
      },
      reasons: [],
    };
  }
}
