// `rua run verify <package> --probe <id> --probe-index <sha256> [--probe-head <sha256>]
// [--head <sha256>]` (design §11, §8.14, §8.16; BR-RUA-054, AC-RUA-027): package verification and
// canonical study completion. Completion reads the original run package only; from outside it
// takes the package verification, the billed-cost checks of the selected BILLING amendments, and
// the transport qualification the operator selected. The selection flags are the ones `run admit`
// takes (evidence/WP-28/decisions.md): BR-RUA-054 asks whether the run executed from "a matching
// transport qualification", which only an explicit selection can answer. Both outputs are written
// under `verifications/<run_id>/`; the command completes only for a `complete` study.

import { readRunPackage } from '../study-comparison/run-package-reader.ts';
import { assessPackageCompletion } from '../study-comparison/run-package-assessment.ts';
import { verifyPackage } from '../evidence-package/package-verifier.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { SelectedRunQualification } from '../study-comparison/study-provenance.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { SELECTION_FLAGS, parseSelection, selectedBilledCostChecks } from './run-completion-inputs.ts';
import type { QualificationReader } from './run-completion-inputs.ts';
import type { LoadedPackage, VerifyCommandDeps } from './verify-commands.ts';
import { loadPackage, notHeld, verifiedReport, verifySpec } from './verify-commands.ts';

const SPEC = verifySpec(
  'run',
  new Map([
    [SELECTION_FLAGS.probe, 'required'],
    [SELECTION_FLAGS.index, 'required'],
    [SELECTION_FLAGS.head, 'optional'],
  ]),
  ' --probe <id> --probe-index <sha256> [--probe-head <sha256>]',
);

/** What run verify reads besides the package: the selected qualification. */
export interface RunVerifyDeps extends VerifyCommandDeps {
  readonly qualifications: QualificationReader;
}

/**
 * The run verify command.
 *
 * @example
 * (await new RunVerifyCommand(deps).run(args, context)).outcome; // 'completed' for a complete study
 */
export class RunVerifyCommand implements CliCommand {
  readonly spec: CommandSpec = SPEC;
  readonly #deps: RunVerifyDeps;

  constructor(deps: RunVerifyDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const selection = parseSelection(args.flags);
    if (!selection.ok) {
      return failedOutcome('usage_error', [selection.error]);
    }
    const assessedAt = formatUtcMillis(this.#deps.clock.now());
    const loaded = await loadPackage(args, context, 'RUN', this.#deps, assessedAt);
    if (!loaded.ok) {
      return loaded.error;
    }
    const qualification = await this.#deps.qualifications.readSelected(selection.value, loaded.value.files);
    return this.#complete(loaded.value, qualification.selected, qualification.reasons, assessedAt);
  }

  async #complete(
    loaded: LoadedPackage,
    selected: SelectedRunQualification | undefined,
    selectionReasons: readonly StructuredReason[],
    assessedAt: UtcMillis,
  ): Promise<CliOutcomeReport> {
    const deps = { validator: this.#deps.validator, digest: sha256Hex };
    const verification = verifyPackage(loaded.input, deps);
    const records = readRunPackage(
      new Map(loaded.input.original.files.map((file) => [file.path, file.bytes] as const)),
      deps,
    );
    if (!records.ok) {
      return verifiedReport(loaded, assessedAt, [['package-verification', verification]], {
        holds: false,
        record: verification,
        reasons: records.error,
        notHeld: notHeld('BR-RUA-054', 'the run package cannot be read', 'a readable run package'),
      });
    }
    const completion = assessPackageCompletion(records.value, {
      original_package_index_sha256: verification.original_package_index_sha256,
      package_verification: verification,
      billed_cost_checks: selectedBilledCostChecks(verification, loaded.input.amendments, this.#deps.validator),
      selected_qualification: selected,
      assessed_at: assessedAt,
    });
    return verifiedReport(
      loaded,
      assessedAt,
      [
        ['package-verification', verification],
        ['study-completion-assessment', completion],
      ],
      {
        holds: completion.study_completion === 'complete',
        record: completion,
        reasons: [...completion.incompletion_reasons, ...selectionReasons],
        notHeld: notHeld('BR-RUA-054', 'the study is incomplete', 'complete'),
      },
    );
  }
}
