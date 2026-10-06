// `rua oracle revision-check [--rev <commit> | --package <package>]` (design §11, D-18; BR-RUA-055,
// AC-RUA-055): the oracle's golden suite is run at a source revision in a temporary git worktree,
// never in the operator's work tree, and judged by admission's attestation rule
// (`oracleRevisionCheck`): exit 0, no failed, skipped or todo test, at least the golden minimum,
// and every verdict-changing rule reached by a passing case. With `--package` the revision is the
// one the package's frozen manifest recorded, and the checked-out tree must be the recorded tree
// too. The printed `oracle_revision_check` is the same record admission freezes; it is stdout only.
// The temporary worktree is always released once it was created.

import type { GoldenSuiteRun } from '../admission/admission-ports.ts';
import { oracleRevisionCheck } from '../admission/oracle-attestation.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { usageReason } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { locatePackage } from './package-location.ts';
import { readPackageManifest } from './package-manifest.ts';

/** A revision checked out in its own temporary worktree. */
export interface RevisionCheckout {
  readonly commit_sha: string;
  readonly tree_sha: string;
  /** The study root (`study-1/`) inside the temporary worktree. */
  readonly study_root: string;
}

/** The temporary worktree a revision check runs in; every call reports failure as a value. */
export interface RevisionWorkspace {
  checkout(revision: string): Promise<Result<RevisionCheckout, StructuredReason>>;
  /** Installs the revision's locked dependencies (`npm ci`) in its study root. */
  install(checkout: RevisionCheckout): Promise<StructuredReason | undefined>;
  runGoldenSuite(checkout: RevisionCheckout): Promise<Result<GoldenSuiteRun, StructuredReason>>;
  /** Removes the worktree; called exactly once for every successful checkout. */
  release(checkout: RevisionCheckout): Promise<StructuredReason | undefined>;
}

export interface OracleRevisionCheckDeps {
  readonly workspace: RevisionWorkspace;
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
  readonly clock: WallClock;
  /** `process.version` of the CLI, recorded as the suite's runtime. */
  readonly node_version: string;
}

/** The revision checked when neither flag is given. */
export const DEFAULT_REVISION = 'HEAD';
// A git revision an operator may name: no option-like or whitespace text reaches git.
const REVISION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._/@{}^~-]{0,255}$/;

const SPEC: CommandSpec = {
  words: ['oracle', 'revision-check'],
  positionals: [],
  flags: new Map([
    ['rev', 'optional'],
    ['package', 'optional'],
  ]),
  usage: 'oracle revision-check [--rev <commit> | --package <package>]',
};

interface RevisionTarget {
  readonly revision: string;
  /** The tree the package's manifest recorded, when the revision came from a package. */
  readonly expected_tree_sha?: string;
}

/**
 * The revision-check command.
 *
 * @example
 * const command = new OracleRevisionCheckCommand({ workspace, files, validator, clock, node_version: process.version });
 * (await command.run(args, context)).outcome; // 'completed' when the oracle is final at the revision
 */
export class OracleRevisionCheckCommand implements CliCommand {
  readonly spec: CommandSpec = SPEC;
  readonly #deps: OracleRevisionCheckDeps;

  constructor(deps: OracleRevisionCheckDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const target = await this.#target(args, context);
    if (!target.ok) {
      return target.error;
    }
    const checkout = await this.#deps.workspace.checkout(target.value.revision);
    if (!checkout.ok) {
      return failedOutcome('verification_failed', [checkout.error]);
    }
    context.progress(`checking the oracle at ${checkout.value.commit_sha} in ${checkout.value.study_root}`);
    let report: CliOutcomeReport;
    let released: StructuredReason | undefined;
    try {
      report = await this.#check(checkout.value, target.value);
    } finally {
      released = await this.#deps.workspace.release(checkout.value);
    }
    return released === undefined ? report : { ...report, reasons: [...report.reasons, released] };
  }

  async #target(args: ParsedArgs, context: CommandContext): Promise<Result<RevisionTarget, CliOutcomeReport>> {
    const rev = args.flags.get('rev');
    const packagePath = args.flags.get('package');
    if (rev !== undefined && packagePath !== undefined) {
      return err(failedOutcome('usage_error', [usageReason('--rev and --package were both given', SPEC.usage)]));
    }
    if (packagePath === undefined) {
      return revisionTarget(rev ?? DEFAULT_REVISION);
    }
    const identity = locatePackage(context.evidence_root, context.resolvePath(packagePath));
    if (!identity.ok) {
      return err(failedOutcome('usage_error', [identity.error]));
    }
    const admitted = await readPackageManifest(
      this.#deps.files(context.evidence_root),
      identity.value,
      this.#deps.validator,
    );
    if (!admitted.ok) {
      return err(failedOutcome('verification_failed', [admitted.error]));
    }
    // The manifest schema pins both to hex object names, so the commit needs no revision-name check.
    const { commit_sha: commitSha, tree_sha: treeSha } = admitted.value.manifest.source;
    return ok({ revision: commitSha, expected_tree_sha: treeSha });
  }

  async #check(checkout: RevisionCheckout, target: RevisionTarget): Promise<CliOutcomeReport> {
    if (target.expected_tree_sha !== undefined && target.expected_tree_sha !== checkout.tree_sha) {
      return failedOutcome('verification_failed', [
        revisionReason(
          'REVISION_TREE_MISMATCH',
          `commit ${checkout.commit_sha} has tree ${checkout.tree_sha}, but the manifest recorded tree ${boundedJsonText(target.expected_tree_sha)}; expected the recorded tree`,
        ),
      ]);
    }
    const installed = await this.#deps.workspace.install(checkout);
    if (installed !== undefined) {
      return failedOutcome('verification_failed', [installed]);
    }
    const run = await this.#deps.workspace.runGoldenSuite(checkout);
    if (!run.ok) {
      return failedOutcome('verification_failed', [run.error]);
    }
    const record = oracleRevisionCheck(run.value, {
      commit_sha: checkout.commit_sha,
      tree_sha: checkout.tree_sha,
      node_version: this.#deps.node_version,
      checked_at: formatUtcMillis(this.#deps.clock.now()),
    });
    return {
      outcome: record.result === 'passed' ? 'completed' : 'verification_failed',
      written_paths: [],
      result_record: record as unknown as JsonObject,
      reasons: record.reasons,
    };
  }
}

function revisionTarget(revision: string): Result<RevisionTarget, CliOutcomeReport> {
  if (!REVISION_PATTERN.test(revision)) {
    return err(
      failedOutcome('usage_error', [
        usageReason(
          `revision ${boundedJsonText(revision)} is not a git revision name`,
          'a commit, branch or tag name that starts with a letter or digit and holds no whitespace',
        ),
      ]),
    );
  }
  return ok({ revision });
}

/**
 * A reason of the revision check (BR-RUA-055).
 *
 * @example
 * revisionReason('REVISION_UNRESOLVED', 'git rev-parse found no commit "nope"; expected a commit');
 */
export function revisionReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-055', detail };
}
