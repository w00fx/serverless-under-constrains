// `rua probe admit`, `rua validation admit` and `rua run admit` (design §11, §10.1; BR-RUA-039..042,
// -017, -028, -046, -055): read-only admission of one execution. The command reads the operator's
// inputs, builds the admission request and hands it to admission, which owns every check and
// every write (the attempt journal, the rejection, or the admitted package's `admission/`).
// Admitted is exit 0 with the manifest path; rejected is exit 3 with the rejection path and the
// reasons; an attempt whose own evidence could not be written is exit 10.
//
// Inputs (evidence/WP-28/decisions.md): the environment input file (`--env`), the selected probe
// of a run or a validation (`--probe`, `--probe-index`, `--probe-head`), the validated variant
// (`--variant`), and the two financial input records (`--payment`, `--approved-decision`), which
// admission's request carries and the design's command table does not name.

import type { AdmissionOutcome, AdmissionRequest, FinancialInputRecords } from '../admission/admission-ports.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { VARIANT_IDS, err, ok } from '../record-contract/primitives.ts';
import type { ExecutionKind, JsonValue, Result, StructuredReason, VariantId } from '../record-contract/primitives.ts';
import { flagValue, usageReason } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type {
  CliCommand,
  CliOutcomeReport,
  CommandContext,
  CommandSpec,
  FlagPresence,
  ParsedArgs,
} from './cli-types.ts';
import { SELECTION_FLAGS, parseSelection } from './run-completion-inputs.ts';

/** Reads the exact bytes of an operator input file. */
export interface InputFileReader {
  readBytes(path: string): Promise<Result<Uint8Array, { readonly code: string; readonly detail: string }>>;
}

/** Admission over the evidence root; production binds `admitExecution` with its real ports. */
export type ExecutionAdmitter = (request: AdmissionRequest, evidenceRoot: string) => Promise<AdmissionOutcome>;

export interface AdmitCommandDeps {
  readonly admit: ExecutionAdmitter;
  readonly inputs: InputFileReader;
}

const INPUT_FLAGS = { env: 'env', payment: 'payment', decision: 'approved-decision', variant: 'variant' } as const;
const COMMAND_WORDS: Readonly<Record<ExecutionKind, string>> = {
  TRANSPORT_PROBE: 'probe',
  VARIANT_VALIDATION: 'validation',
  RUN: 'run',
};

/**
 * The grammar of one kind's admit command.
 *
 * @example
 * admitSpec('RUN').usage; // 'run admit --env <file> --probe <id> --probe-index <sha256> [--probe-head <sha256>] …'
 */
export function admitSpec(kind: ExecutionKind): CommandSpec {
  const selects = kind !== 'TRANSPORT_PROBE';
  const flags: [string, FlagPresence][] = [
    [INPUT_FLAGS.env, 'required'],
    [INPUT_FLAGS.payment, 'required'],
    [INPUT_FLAGS.decision, 'required'],
  ];
  const variant = kind === 'VARIANT_VALIDATION' ? ' --variant conventional|durable' : '';
  if (kind === 'VARIANT_VALIDATION') {
    flags.push([INPUT_FLAGS.variant, 'required']);
  }
  if (selects) {
    flags.push(
      [SELECTION_FLAGS.probe, 'required'],
      [SELECTION_FLAGS.index, 'required'],
      [SELECTION_FLAGS.head, 'optional'],
    );
  }
  const selection = selects ? ' --probe <id> --probe-index <sha256> [--probe-head <sha256>]' : '';
  return {
    words: [COMMAND_WORDS[kind], 'admit'],
    positionals: [],
    flags: new Map(flags),
    usage: `${COMMAND_WORDS[kind]} admit --env <file>${variant}${selection} --payment <file> --approved-decision <file>`,
  };
}

/**
 * One kind's admit command.
 *
 * @example
 * (await new AdmitCommand('TRANSPORT_PROBE', deps).run(args, context)).outcome; // 'completed' when admitted
 */
export class AdmitCommand implements CliCommand {
  readonly spec: CommandSpec;
  readonly #kind: ExecutionKind;
  readonly #deps: AdmitCommandDeps;

  constructor(kind: ExecutionKind, deps: AdmitCommandDeps) {
    this.#kind = kind;
    this.#deps = deps;
    this.spec = admitSpec(kind);
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const request = await this.#request(args, context);
    if (!request.ok) {
      return failedOutcome('usage_error', [request.error]);
    }
    context.progress(`admitting a ${this.#kind} with ${request.value.environment_input_path}`);
    return admissionReport(await this.#deps.admit(request.value, context.evidence_root));
  }

  async #request(args: ParsedArgs, context: CommandContext): Promise<Result<AdmissionRequest, StructuredReason>> {
    const choices = this.#choices(args.flags);
    if (!choices.ok) {
      return choices;
    }
    const financial = await this.#financialInputs(args.flags, context);
    if (!financial.ok) {
      return financial;
    }
    return ok({
      kind: this.#kind,
      environment_input_path: context.resolvePath(flagValue(args.flags, INPUT_FLAGS.env)),
      financial_inputs: financial.value,
      ...choices.value,
    });
  }

  #choices(
    flags: ReadonlyMap<string, string>,
  ): Result<Pick<AdmissionRequest, 'variant' | 'qualification'>, StructuredReason> {
    if (this.#kind === 'TRANSPORT_PROBE') {
      return ok({});
    }
    const selection = parseSelection(flags);
    if (!selection.ok) {
      return selection;
    }
    if (this.#kind === 'RUN') {
      return ok({ qualification: selection.value });
    }
    const variant = parseVariant(flagValue(flags, INPUT_FLAGS.variant));
    return variant.ok ? ok({ qualification: selection.value, variant: variant.value }) : variant;
  }

  async #financialInputs(
    flags: ReadonlyMap<string, string>,
    context: CommandContext,
  ): Promise<Result<FinancialInputRecords, StructuredReason>> {
    const payment = await this.#readJson(INPUT_FLAGS.payment, flags, context);
    if (!payment.ok) {
      return payment;
    }
    const decision = await this.#readJson(INPUT_FLAGS.decision, flags, context);
    return decision.ok ? ok({ payment: payment.value, approved_decision: decision.value }) : decision;
  }

  async #readJson(
    flag: string,
    flags: ReadonlyMap<string, string>,
    context: CommandContext,
  ): Promise<Result<JsonValue, StructuredReason>> {
    const path = context.resolvePath(flagValue(flags, flag));
    const bytes = await this.#deps.inputs.readBytes(path);
    if (!bytes.ok) {
      return err(inputReason(flag, path, `${bytes.error.code}: ${bytes.error.detail}`));
    }
    const parsed = parseJsonDocument(bytes.value);
    if (!parsed.ok) {
      const problem =
        parsed.error.kind === 'invalid_utf8'
          ? `invalid UTF-8 at byte ${String(parsed.error.byte_offset)}`
          : parsed.error.detail;
      return err(inputReason(flag, path, problem));
    }
    return ok(parsed.value);
  }
}

/**
 * The CLI report of an admission outcome.
 *
 * @example
 * admissionReport({ kind: 'rejected', admission_attempt_id, rejection_path, reasons }).outcome; // 'admission_rejected'
 */
export function admissionReport(outcome: AdmissionOutcome): CliOutcomeReport {
  switch (outcome.kind) {
    case 'admitted':
      return {
        outcome: 'completed',
        execution: outcome.execution,
        written_paths: [outcome.manifest_path],
        reasons: [],
      };
    case 'rejected':
      return { outcome: 'admission_rejected', written_paths: [outcome.rejection_path], reasons: outcome.reasons };
    case 'failed':
      return failedOutcome('internal_failure', outcome.reasons);
  }
}

function parseVariant(value: string): Result<VariantId, StructuredReason> {
  const variant = VARIANT_IDS.find((candidate) => candidate === value);
  return variant === undefined
    ? err(usageReason(`--variant ${boundedJsonText(value)} is not a variant`, `one of ${VARIANT_IDS.join(', ')}`))
    : ok(variant);
}

function inputReason(flag: string, path: string, problem: string): StructuredReason {
  return usageReason(
    `--${flag} ${boundedJsonText(path)} cannot be read: ${boundedText(problem)}`,
    'a readable UTF-8 JSON document',
  );
}
