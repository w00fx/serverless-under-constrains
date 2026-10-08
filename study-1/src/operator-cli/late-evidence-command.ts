// `rua late-evidence assess <package>` (design §8.13, §11; BR-RUA-043, BR-RUA-044; AC-RUA-030):
// reassesses a finalized package's late evidence into one LATE_EVIDENCE amendment
// (`assessLateEvidenceAmendment`), never touching the package. Where the late stream comes from
// follows the package's effective closure (`package-closure.ts`):
// - cleanup `succeeded` with a `clean` audit proves the execution's tables gone, so the stream is
//   the one the package froze at cleanup step 1;
// - any other closure may have left the tables readable, so the stream is re-captured over them;
//   a capture that fails writes nothing (the service refuses), so a lost table can never pass for
//   an empty late stream.
// It mutates nothing in the cloud: the capture only reads. Exit 0 once the amendment is written;
// a refusal is 5, an amendment that could not be stored 10.

import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import type { LateEvidenceAmendment } from '../execution-lifecycle/late-evidence-amendment.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import type { JsonObject, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readAdmittedPackage } from './admitted-package.ts';
import { amendmentRefusal, amendmentWrittenPath } from './amendment-report.ts';
import { operandOf } from './arg-parsing.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { readPackageClosure, resourcesProvenGone } from './package-closure.ts';

/** One reassessment to run. */
export interface LateEvidenceRequest {
  readonly admitted: AdmittedExecution;
  /** True to re-capture the stream over the execution's tables; false for the packaged stream. */
  readonly capture: boolean;
  readonly evidence_root: string;
}

/** Runs `assessLateEvidenceAmendment` with or without the capture readers (production: AWS). */
export type LateEvidenceLauncher = (
  request: LateEvidenceRequest,
) => Promise<Result<LateEvidenceAmendment, readonly StructuredReason[]>>;

/** What the command reads and runs through. */
export interface LateEvidenceCommandDeps {
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
  readonly assess: LateEvidenceLauncher;
}

const PACKAGE_OPERAND = 'package';

/**
 * `late-evidence assess <package>`.
 *
 * @example
 * await main(['late-evidence', 'assess', 'evidence/runs/<id>'], io, root);
 */
export class LateEvidenceAssessCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['late-evidence', 'assess'],
    positionals: [PACKAGE_OPERAND],
    flags: new Map(),
    usage: 'late-evidence assess <package>',
  };
  readonly #deps: LateEvidenceCommandDeps;

  constructor(deps: LateEvidenceCommandDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const files = this.#deps.files(context.evidence_root);
    const admitted = await readAdmittedPackage(operandOf(args, PACKAGE_OPERAND), context, {
      files,
      validator: this.#deps.validator,
    });
    if (!admitted.ok) {
      return admitted.error;
    }
    const closure = await readPackageClosure(files, admitted.value, this.#deps.validator);
    if (!closure.ok) {
      return amendmentRefusal(admitted.value.identity, [closure.error]);
    }
    const capture = !resourcesProvenGone(closure.value.closure);
    context.progress(
      `reassessing ${admitted.value.package_directory} from ${capture ? 'a re-capture over its tables' : 'its packaged late stream'}`,
    );
    const amended = await this.#deps.assess({
      admitted: admitted.value,
      capture,
      evidence_root: context.evidence_root,
    });
    if (!amended.ok) {
      return amendmentRefusal(admitted.value.identity, amended.error);
    }
    return {
      outcome: 'completed',
      execution: admitted.value.identity,
      written_paths: [amendmentWrittenPath(amended.value.amendment_directory)],
      result_record: amended.value.assessment as unknown as JsonObject,
      reasons: [],
    };
  }
}
