// Admission step A5 (SOURCE_PROVENANCE; BR-RUA-042, design §10.1): only clean committed source
// produces citable evidence. The work tree is clean when porcelain v2 lists no changed, renamed,
// unmerged or untracked entry and no unreadable record; no merge, rebase or cherry-pick is in
// progress; HEAD resolves to a commit and a tree; and the lockfile is present and tracked. A
// modified lockfile or a dirty submodule is a status entry like any other, named by its own code
// so the operator sees which rule failed. Ignored entries never make a tree dirty.

import { sha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import type { Sha256Hex, StructuredReason, UtcMillis, Uuid4 } from '../record-contract/primitives.ts';
import type { SourceProvenance, ToolVersions } from '../record-contract/records/group-a/source_provenance.ts';
import type { GitSourceState } from './admission-ports.ts';
import { admissionReason } from './admission-reason.ts';
import { parseGitPorcelainV2 } from './git-porcelain.ts';
import type { GitStatusEntry, GitStatusSnapshot } from './git-porcelain.ts';
import { failed, verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-042';
/** Git object ids: SHA-1 (40 hex) or SHA-256 (64 hex). */
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The most dirty entries one rejection quotes; the count names the rest. */
const QUOTED_ENTRIES = 10;
const CLEAN_SUBMODULE = 'N...';

/** The clean committed source an admission freezes. */
export interface AdmittedSource {
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly branch?: string;
  readonly lockfile_path: string;
  readonly lockfile_sha256: Sha256Hex;
}

/**
 * Every BR-RUA-042 problem of a parsed status and the git state around it; empty when clean.
 *
 * @example
 * sourceProvenanceReasons(parseGitPorcelainV2('# branch.oid …\0? x\0'), state)[0]?.code; // 'UNTRACKED_FILE'
 */
export function sourceProvenanceReasons(
  snapshot: GitStatusSnapshot,
  state: GitSourceState,
): readonly StructuredReason[] {
  return [
    ...headReasons(snapshot, state.tree_sha),
    ...state.in_progress.map((operation) =>
      admissionReason('OPERATION_IN_PROGRESS', SUBJECT, `a ${operation} is in progress; expected none`),
    ),
    ...snapshot.malformed
      .slice(0, QUOTED_ENTRIES)
      .map((record) =>
        admissionReason(
          'GIT_STATUS_UNREADABLE',
          SUBJECT,
          `git status record ${boundedJsonText(record)} is unreadable; expected a porcelain v2 record`,
        ),
      ),
    ...dirtyReasons(snapshot.entries, state.lockfile.path),
    ...lockfileReasons(state.lockfile),
  ];
}

/**
 * Step A5 over what git reports.
 *
 * @example
 * const verdict = assessSourceProvenance(state);
 * if (verdict.passed) verdict.value.commit_sha; // '1f2e…'
 */
export function assessSourceProvenance(state: GitSourceState): StepVerdict<AdmittedSource> {
  const snapshot = parseGitPorcelainV2(state.status_porcelain_v2);
  const statement: CheckStatement = {
    subject: 'source_provenance',
    expected: 'clean_committed_source',
    observed: {
      commit_sha: snapshot.commit_sha ?? 'unresolved',
      dirty_entries: snapshot.entries.filter((entry) => entry.kind !== 'ignored').length,
    },
  };
  const reasons = sourceProvenanceReasons(snapshot, state);
  const { bytes } = state.lockfile;
  if (bytes === undefined) {
    return failed('SOURCE_PROVENANCE', statement, [lockfileMissing(state.lockfile.path), ...reasons]);
  }
  return verdictOf('SOURCE_PROVENANCE', statement, reasons, {
    commit_sha: String(snapshot.commit_sha),
    tree_sha: String(state.tree_sha),
    ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
    lockfile_path: state.lockfile.path,
    lockfile_sha256: sha256Hex(bytes),
  });
}

/**
 * The `source_provenance` record of an admitted source.
 *
 * @example
 * sourceProvenanceRecord(attemptId, source, { node: 'v24.15.0' }, at).clean_confirmed; // true
 */
export function sourceProvenanceRecord(
  admissionAttemptId: Uuid4,
  source: AdmittedSource,
  toolVersions: ToolVersions,
  recordedAt: UtcMillis,
): SourceProvenance {
  const head =
    source.branch === undefined
      ? { detached_head: true as const }
      : { detached_head: false as const, branch: source.branch };
  return {
    schema_version: 1,
    record_type: 'source_provenance',
    admission_attempt_id: admissionAttemptId,
    ...head,
    commit_sha: source.commit_sha,
    tree_sha: source.tree_sha,
    clean_confirmed: true,
    lockfile_path: source.lockfile_path,
    lockfile_sha256: source.lockfile_sha256,
    tool_versions: toolVersions,
    recorded_at: recordedAt,
  };
}

function headReasons(snapshot: GitStatusSnapshot, treeSha: string | undefined): readonly StructuredReason[] {
  const reasons: StructuredReason[] = [];
  if (snapshot.commit_sha === undefined || !GIT_OBJECT_PATTERN.test(snapshot.commit_sha)) {
    reasons.push(
      admissionReason(
        'HEAD_UNRESOLVED',
        SUBJECT,
        `HEAD commit is ${snapshot.commit_sha === undefined ? 'absent' : boundedJsonText(snapshot.commit_sha)}; expected a 40 or 64 hex git object id`,
      ),
    );
  }
  if (treeSha === undefined || !GIT_OBJECT_PATTERN.test(treeSha)) {
    reasons.push(
      admissionReason(
        'TREE_UNRESOLVED',
        SUBJECT,
        `HEAD tree is ${treeSha === undefined ? 'absent' : boundedJsonText(treeSha)}; expected a 40 or 64 hex git object id`,
      ),
    );
  }
  return reasons;
}

function dirtyReasons(entries: readonly GitStatusEntry[], lockfilePath: string): readonly StructuredReason[] {
  const dirty = entries.filter((entry) => entry.kind !== 'ignored');
  const quoted = dirty.slice(0, QUOTED_ENTRIES).map((entry) => dirtyReason(entry, lockfilePath));
  if (dirty.length <= QUOTED_ENTRIES) {
    return quoted;
  }
  return [
    ...quoted,
    admissionReason(
      'WORK_TREE_DIRTY',
      SUBJECT,
      `${String(dirty.length - QUOTED_ENTRIES)} more dirty entries are not quoted; expected a clean work tree`,
    ),
  ];
}

function dirtyReason(entry: GitStatusEntry, lockfilePath: string): StructuredReason {
  const path = boundedText(entry.path);
  if (entry.kind === 'untracked') {
    return admissionReason('UNTRACKED_FILE', SUBJECT, `${path} is untracked; expected no untracked file`);
  }
  if (entry.path === lockfilePath) {
    return admissionReason('LOCKFILE_MODIFIED', SUBJECT, `${path} is ${entry.kind}; expected the committed lockfile`);
  }
  if (entry.submodule !== undefined && entry.submodule !== CLEAN_SUBMODULE) {
    return admissionReason(
      'SUBMODULE_DIRTY',
      SUBJECT,
      `submodule ${path} has state ${boundedText(entry.submodule)}; expected a clean submodule at its recorded commit`,
    );
  }
  return admissionReason('TRACKED_FILE_MODIFIED', SUBJECT, `${path} is ${entry.kind}; expected no uncommitted change`);
}

function lockfileReasons(lockfile: GitSourceState['lockfile']): readonly StructuredReason[] {
  return lockfile.tracked
    ? []
    : [
        admissionReason(
          'LOCKFILE_UNTRACKED',
          SUBJECT,
          `${boundedText(lockfile.path)} is not tracked by git; expected a committed lockfile`,
        ),
      ];
}

function lockfileMissing(path: string): StructuredReason {
  return admissionReason(
    'LOCKFILE_MISSING',
    SUBJECT,
    `${boundedText(path)} does not exist; expected a committed lockfile`,
  );
}
