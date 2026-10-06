// `rua oracle evaluate <trial-dir>` (design §11, CF "the oracle is a pure function of bytes"):
// re-evaluates one frozen trial from its stored package bytes and prints the `oracle_result` on
// stdout only; nothing is written. The trial directory is
// `<evidence-root>/{runs|variant-validations}/<execution_id>/trials/<trial_id>`; a probe has no
// trials. The command completes whenever the oracle answers, whatever the verdict; an input it
// cannot read, or an evaluation the oracle refuses, is `verification_failed` with the reasons.

import { basename, dirname } from 'node:path';

import { ingestEvidence } from '../evidence-ingestion/ingest-evidence.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  Result,
  StructuredReason,
  Uuid4,
  WallClock,
} from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { evaluateTrial } from '../trial-oracle/evaluate-trial.ts';
import { operandOf, usageReason } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { frozenTrialInput } from './frozen-trial-input.ts';
import { locatePackage } from './package-location.ts';

/** What the evaluation reads and stamps its result with. */
export interface OracleEvaluateDeps {
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
  readonly clock: WallClock;
}

const TRIAL_OPERAND = 'trial-dir';
const TRIAL_SHAPE = '<evidence-root>/{runs|variant-validations}/<execution_id>/trials/<trial_id>';

interface TrialLocation {
  readonly execution: ExecutionIdentity;
  readonly trial_id: Uuid4;
}

/**
 * The oracle evaluate command.
 *
 * @example
 * (await new OracleEvaluateCommand(deps).run(args, context)).result_record; // the re-evaluated oracle_result
 */
export class OracleEvaluateCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['oracle', 'evaluate'],
    positionals: [TRIAL_OPERAND],
    flags: new Map(),
    usage: 'oracle evaluate <trial-dir>',
  };
  readonly #deps: OracleEvaluateDeps;

  constructor(deps: OracleEvaluateDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const location = locateTrial(context.evidence_root, context.resolvePath(operandOf(args, TRIAL_OPERAND)));
    if (!location.ok) {
      return failedOutcome('usage_error', [location.error]);
    }
    const { execution, trial_id: trialId } = location.value;
    const snapshot = await readPackageSnapshot(this.#deps.files(context.evidence_root), execution);
    if (!snapshot.ok) {
      const detail = `${snapshot.error.code}: ${snapshot.error.detail}; expected a readable package directory`;
      return failedOutcome('verification_failed', [{ code: 'PACKAGE_UNREADABLE', subject: 'BR-RUA-044', detail }]);
    }
    const input = frozenTrialInput(snapshot.value.files, trialId, this.#deps.validator);
    if (!input.ok) {
      return { ...failedOutcome('verification_failed', [input.error]), execution };
    }
    context.progress(`re-evaluating trial ${trialId} from its frozen bytes`);
    const evidence = ingestEvidence(input.value, this.#deps.validator);
    const evaluation = evaluateTrial({ evidence, checked_at: formatUtcMillis(this.#deps.clock.now()) });
    if (!evaluation.ok) {
      return { ...failedOutcome('verification_failed', evaluation.error), execution };
    }
    return {
      outcome: 'completed',
      execution,
      written_paths: [],
      result_record: evaluation.value.result as unknown as JsonObject,
      reasons: [],
    };
  }
}

/**
 * The execution and trial a trial directory names.
 *
 * @example
 * locateTrial('/s/evidence', '/s/evidence/runs/<run_id>/trials/<trial_id>'); // { ok: true, value: { execution, trial_id } }
 */
export function locateTrial(evidenceRoot: string, trialDirectory: string): Result<TrialLocation, StructuredReason> {
  const trialsDirectory = dirname(trialDirectory);
  const trialId = basename(trialDirectory);
  const located = locatePackage(evidenceRoot, dirname(trialsDirectory));
  const named = basename(trialsDirectory) === 'trials' && isUuid4(trialId);
  if (!named || !located.ok || located.value.execution_kind === 'TRANSPORT_PROBE') {
    return err(usageReason(`trial directory ${boundedJsonText(trialDirectory)} names no trial`, TRIAL_SHAPE));
  }
  return ok({ execution: located.value, trial_id: trialId });
}
