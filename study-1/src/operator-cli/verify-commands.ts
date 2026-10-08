// `rua probe verify`, `rua validation verify` and `rua run verify` (design §11, §8.11, §8.15,
// §8.16, §8.14): read a stored package and every amendment found for it, verify it with the
// operator's explicit `--head` (none selects the original package alone), and write the verifier
// outputs once under `verifications/<execution_id>/`, never inside the package. Each command
// completes (exit 0) only when its question is answered yes: the probe is usable (BR-RUA-026), the
// validation is `verified` (CTR-RUA-004), the run completes the study (BR-RUA-054); every other
// answer is `verification_failed` (exit 5) with the verifier's reasons. A package that cannot be
// read is `verification_failed` too; an output that cannot be written is an internal failure.

import type { ProbePackageInput } from '../transport-qualification/verdict/probe-usability-reader.ts';
import { readProbeUsabilityInput } from '../transport-qualification/verdict/probe-usability-reader.ts';
import { assessProbeUsability } from '../transport-qualification/verdict/probe-usability.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { executionIdOf } from '../evidence-package/package-layout.ts';
import type { VerificationKind } from '../evidence-package/package-layout.ts';
import type { PackageVerificationInput } from '../evidence-package/package-verifier.ts';
import { verifyPackage } from '../evidence-package/package-verifier.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  ExecutionKind,
  JsonObject,
  Result,
  StructuredReason,
  UtcMillis,
  WallClock,
} from '../record-contract/primitives.ts';
import type { StudyRecord } from '../record-contract/records/index.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { verifyVariantValidation } from '../variant-validation/variant-validation-verifier.ts';
import { operandOf } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { locatePackageOfKind } from './package-location.ts';
import type { PackageCommandDeps } from './package-reading.ts';
import { parseDigestFlag, readVerificationInput, writeVerification } from './package-reading.ts';

/** What a verify command reads, writes and stamps its outputs with. */
export interface VerifyCommandDeps extends PackageCommandDeps {
  readonly clock: WallClock;
}

/** A located, read package, ready to verify. */
export interface LoadedPackage {
  readonly identity: ExecutionIdentity;
  readonly files: PackageFileSystem;
  readonly input: PackageVerificationInput;
}

const HEAD_FLAG = 'head';
const PACKAGE_OPERAND = 'package';

/**
 * The grammar of a verify command; `extra` adds flags and their usage text.
 *
 * @example
 * verifySpec('probe', new Map(), ''); // usage 'probe verify <package> [--head <sha256>]'
 */
export function verifySpec(
  word: string,
  extra: ReadonlyMap<string, 'required' | 'optional'>,
  extraUsage: string,
): CommandSpec {
  return {
    words: [word, 'verify'],
    positionals: [PACKAGE_OPERAND],
    flags: new Map([...extra, [HEAD_FLAG, 'optional']]),
    usage: `${word} verify <package>${extraUsage} [--head <sha256>]`,
  };
}

/**
 * Locates the package operand, reads `--head` and reads the package with every amendment.
 *
 * @example
 * const loaded = await loadPackage(args, context, 'RUN', deps, now);
 * if (loaded.ok) verifyPackage(loaded.value.input, { validator, digest: sha256Hex });
 */
export async function loadPackage(
  args: ParsedArgs,
  context: CommandContext,
  kind: ExecutionKind,
  deps: PackageCommandDeps,
  evaluatedAt: UtcMillis,
): Promise<Result<LoadedPackage, CliOutcomeReport>> {
  const packagePath = context.resolvePath(operandOf(args, PACKAGE_OPERAND));
  const located = locatePackageOfKind(context.evidence_root, packagePath, kind);
  if (!located.ok) {
    return err(failedOutcome('usage_error', [located.error]));
  }
  const head = parseDigestFlag(HEAD_FLAG, args.flags.get(HEAD_FLAG));
  if (!head.ok) {
    return err(failedOutcome('usage_error', [head.error]));
  }
  const files = deps.files(context.evidence_root);
  const input = await readVerificationInput(files, located.value, head.value, evaluatedAt, deps.validator);
  if (!input.ok) {
    return err(failedOutcome('verification_failed', [input.error]));
  }
  context.progress(`verifying ${packagePath} with head ${head.value ?? 'none (the original package)'}`);
  return ok({ identity: located.value, files, input: input.value });
}

/**
 * Writes the outputs in order and reports the answer: `completed` when `holds`, else
 * `verification_failed` with the reasons, or `notHeld` when the verifier gave none.
 *
 * @example
 * await verifiedReport(loaded, now, [['package-verification', verification]], { holds: true, … });
 */
export async function verifiedReport(
  loaded: LoadedPackage,
  evaluatedAt: UtcMillis,
  outputs: readonly (readonly [VerificationKind, StudyRecord])[],
  answer: VerifierAnswer,
): Promise<CliOutcomeReport> {
  const writtenPaths: string[] = [];
  for (const [kind, record] of outputs) {
    const written = await writeVerification(loaded.files, loaded.identity, evaluatedAt, kind, record);
    if (!written.ok) {
      return { ...failedOutcome('internal_failure', [written.error]), written_paths: writtenPaths };
    }
    writtenPaths.push(written.value);
  }
  const reasons = answer.holds || answer.reasons.length > 0 ? answer.reasons : [answer.notHeld];
  return {
    outcome: answer.holds ? 'completed' : 'verification_failed',
    execution: loaded.identity,
    written_paths: writtenPaths,
    result_record: answer.record as unknown as JsonObject,
    reasons,
  };
}

/** A verifier's answer to the command's question. */
export interface VerifierAnswer {
  readonly holds: boolean;
  readonly record: StudyRecord;
  readonly reasons: readonly StructuredReason[];
  /** The reason a `no` answer reports when the verifier listed none. */
  readonly notHeld: StructuredReason;
}

const DEPS_DIGEST = { digest: sha256Hex } as const;

/**
 * `probe verify <package> [--head <sha256>]`: package verification and BR-RUA-026 usability.
 *
 * @example
 * (await new ProbeVerifyCommand(deps).run(args, context)).outcome; // 'completed' for a usable probe
 */
export class ProbeVerifyCommand implements CliCommand {
  readonly spec: CommandSpec = verifySpec('probe', new Map(), '');
  readonly #deps: VerifyCommandDeps;

  constructor(deps: VerifyCommandDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const evaluatedAt = formatUtcMillis(this.#deps.clock.now());
    const loaded = await loadPackage(args, context, 'TRANSPORT_PROBE', this.#deps, evaluatedAt);
    if (!loaded.ok) {
      return loaded.error;
    }
    const recordDeps = { validator: this.#deps.validator, ...DEPS_DIGEST };
    // `loadPackage` located a TRANSPORT_PROBE package, so the input is a probe package input.
    const input = loaded.value.input as ProbePackageInput;
    const verification = verifyPackage(input, recordDeps);
    const usability = assessProbeUsability(readProbeUsabilityInput(input, recordDeps));
    return verifiedReport(
      loaded.value,
      evaluatedAt,
      [
        ['package-verification', verification],
        ['probe-usability-assessment', usability],
      ],
      {
        holds: usability.probe_usability === 'usable',
        record: usability,
        reasons: usability.reasons,
        notHeld: notHeld('BR-RUA-026', 'the probe is not usable', 'a usable probe'),
      },
    );
  }
}

/**
 * `validation verify <package> [--head <sha256>]`: the CTR-RUA-004 verifier.
 *
 * @example
 * (await new ValidationVerifyCommand(deps).run(args, context)).outcome; // 'completed' when verified
 */
export class ValidationVerifyCommand implements CliCommand {
  readonly spec: CommandSpec = verifySpec('validation', new Map(), '');
  readonly #deps: VerifyCommandDeps;

  constructor(deps: VerifyCommandDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const evaluatedAt = formatUtcMillis(this.#deps.clock.now());
    const loaded = await loadPackage(args, context, 'VARIANT_VALIDATION', this.#deps, evaluatedAt);
    if (!loaded.ok) {
      return loaded.error;
    }
    const { input } = loaded.value;
    const verified = verifyVariantValidation(
      {
        variant_validation_id: executionIdOf(input.identity),
        original: input.original,
        amendments: input.amendments,
        selected_head: input.selected_head,
        referenced_package_indexes: input.referenced_package_indexes,
        checked_at: evaluatedAt,
      },
      { validator: this.#deps.validator, ...DEPS_DIGEST },
    );
    if (!verified.ok) {
      return { ...failedOutcome('verification_failed', [verified.error]), execution: loaded.value.identity };
    }
    const verification = verified.value;
    return verifiedReport(loaded.value, evaluatedAt, [['variant-validation-verification', verification]], {
      holds: verification.effective_implementation_validation_status === 'verified',
      record: verification,
      reasons: verification.effective_status_reasons,
      notHeld: notHeld(
        'CTR-RUA-004',
        `the effective implementation-validation status is ${verification.effective_implementation_validation_status}`,
        'verified',
      ),
    });
  }
}

/**
 * The reason a verifier's `no` reports when it listed none.
 *
 * @example
 * notHeld('BR-RUA-054', 'the study is incomplete', 'complete');
 */
export function notHeld(subject: string, problem: string, expected: string): StructuredReason {
  return { code: 'VERIFICATION_NOT_HELD', subject, detail: `${problem}; expected ${expected}` };
}
