// Step A5 (BR-RUA-042): only a clean committed tree with a resolved HEAD and a tracked lockfile
// is admitted; every problem has its own code, dirty entries and unreadable records are quoted up
// to ten with the rest counted, the observed values stay bounded, and the `source_provenance`
// record states the admitted source.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessSourceProvenance,
  sourceProvenanceReasons,
  sourceProvenanceRecord,
} from '../../../src/admission/source-provenance.ts';
import { parseGitPorcelainV2 } from '../../../src/admission/git-porcelain.ts';
import type { GitSourceState } from '../../../src/admission/admission-ports.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  BRANCH,
  COMMIT_SHA,
  LOCKFILE_PATH,
  LOCKFILE_TEXT,
  TREE_SHA,
} from '../../support/admission/admission-fixtures.ts';
import { FakeGitRepository } from '../../support/admission/fake-git-repository.ts';

async function stateOf(git: FakeGitRepository): Promise<GitSourceState> {
  const state = await git.readGitSourceState();
  assert.ok(state.ok);
  return state.value;
}

async function codesOf(git: FakeGitRepository): Promise<readonly string[]> {
  const verdict = assessSourceProvenance(await stateOf(git));
  return verdict.passed ? [] : verdict.reasons.map((reason) => reason.code);
}

describe('assessSourceProvenance (A5)', () => {
  it('admits a clean committed tree on a branch', async () => {
    const verdict = assessSourceProvenance(await stateOf(new FakeGitRepository()));
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, {
      commit_sha: COMMIT_SHA,
      tree_sha: TREE_SHA,
      branch: BRANCH,
      lockfile_path: LOCKFILE_PATH,
      lockfile_sha256: sha256Hex(new TextEncoder().encode(LOCKFILE_TEXT)),
    });
    assert.deepEqual(verdict.statement.observed, { commit_sha: COMMIT_SHA, dirty_entries: 0 });
  });

  it('admits a detached HEAD and ignores ignored files', async () => {
    const git = new FakeGitRepository();
    git.detachHead();
    git.ignore('study-1/node_modules/x.js');
    const verdict = assessSourceProvenance(await stateOf(git));
    assert.ok(verdict.passed);
    assert.equal(Object.hasOwn(verdict.value, 'branch'), false);
  });

  it('names each kind of dirty entry', async () => {
    const git = new FakeGitRepository();
    git.addUntracked('study-1/notes.txt');
    git.modifyLockfile();
    git.dirtySubmodule('vendor/sub');
    git.modify('study-1/src/a.ts');
    git.rename('study-1/old.ts', 'study-1/new.ts');
    assert.deepEqual(await codesOf(git), [
      'UNTRACKED_FILE',
      'LOCKFILE_MODIFIED',
      'SUBMODULE_DIRTY',
      'TRACKED_FILE_MODIFIED',
      'TRACKED_FILE_MODIFIED',
    ]);
  });

  it('quotes ten dirty entries and counts the rest', async () => {
    const git = new FakeGitRepository();
    for (let index = 0; index < 13; index += 1) {
      git.addUntracked(`study-1/f${String(index)}.txt`);
    }
    const verdict = assessSourceProvenance(await stateOf(git));
    assert.ok(!verdict.passed);
    assert.equal(verdict.reasons.length, 11);
    assert.deepEqual(verdict.reasons.at(-1), {
      code: 'WORK_TREE_DIRTY',
      subject: 'BR-RUA-042',
      detail: '3 more dirty entries are not quoted; expected a clean work tree',
    });
  });

  it('refuses an operation in progress', async () => {
    const git = new FakeGitRepository();
    git.startOperation('CHERRY_PICK');
    const verdict = assessSourceProvenance(await stateOf(git));
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.reasons[0], {
      code: 'OPERATION_IN_PROGRESS',
      subject: 'BR-RUA-042',
      detail: 'a CHERRY_PICK is in progress; expected none',
    });
  });

  it('refuses an unresolved HEAD and tree', async () => {
    const git = new FakeGitRepository();
    git.unborn();
    assert.deepEqual(await codesOf(git), ['HEAD_UNRESOLVED', 'TREE_UNRESOLVED']);
    const malformedIds = await codesOf(new FakeGitRepository({ commit_sha: 'HEAD', tree_sha: 'abc' }));
    assert.deepEqual(malformedIds, ['HEAD_UNRESOLVED', 'TREE_UNRESOLVED']);
    const sha256Ids = await codesOf(new FakeGitRepository({ commit_sha: 'a'.repeat(64), tree_sha: 'b'.repeat(64) }));
    assert.deepEqual(sha256Ids, []);
  });

  it('refuses an untracked, a deleted or a missing lockfile', async () => {
    const untracked = new FakeGitRepository();
    untracked.untrackLockfile();
    assert.deepEqual(await codesOf(untracked), ['UNTRACKED_FILE', 'LOCKFILE_UNTRACKED']);
    const deleted = new FakeGitRepository();
    deleted.removeLockfile();
    const verdict = assessSourceProvenance(await stateOf(deleted));
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.reasons[0], {
      code: 'LOCKFILE_MISSING',
      subject: 'BR-RUA-042',
      detail: `${LOCKFILE_PATH} does not exist; expected a committed lockfile`,
    });
  });

  it('refuses unreadable status records, quoting ten and counting the rest', () => {
    const state: GitSourceState = {
      status_porcelain_v2: `# branch.oid ${COMMIT_SHA}\0${'?\0'.repeat(12)}`,
      tree_sha: TREE_SHA,
      in_progress: [],
      lockfile: { path: LOCKFILE_PATH, tracked: true, bytes: new Uint8Array() },
    };
    const reasons = sourceProvenanceReasons(parseGitPorcelainV2(state.status_porcelain_v2), state);
    assert.equal(reasons.length, 11);
    assert.deepEqual(reasons[0], {
      code: 'GIT_STATUS_UNREADABLE',
      subject: 'BR-RUA-042',
      detail: 'git status record "?" is unreadable; expected a porcelain v2 record',
    });
    // Regression (WP-23 review): the two records past the tenth were dropped without a count.
    assert.deepEqual(reasons[10], {
      code: 'GIT_STATUS_UNREADABLE',
      subject: 'BR-RUA-042',
      detail: '2 more unreadable git status records are not quoted; expected porcelain v2 records',
    });
    const ten = { ...state, status_porcelain_v2: `# branch.oid ${COMMIT_SHA}\0${'?\0'.repeat(10)}` };
    assert.equal(sourceProvenanceReasons(parseGitPorcelainV2(ten.status_porcelain_v2), ten).length, 10);
  });

  it('A-05: states an overlong HEAD commit bounded in the observed value', () => {
    // Regression (WP-23 review): the observed commit was copied unbounded into the journal line.
    const state: GitSourceState = {
      status_porcelain_v2: `# branch.oid ${'f'.repeat(100_000)}\0`,
      tree_sha: TREE_SHA,
      in_progress: [],
      lockfile: { path: LOCKFILE_PATH, tracked: true, bytes: new Uint8Array() },
    };
    const verdict = assessSourceProvenance(state);
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.statement.observed, {
      commit_sha: `${'f'.repeat(200)}…[truncated]`,
      dirty_entries: 0,
    });
    assert.deepEqual(
      verdict.reasons.map((reason) => [reason.code, reason.detail.length < 400]),
      [['HEAD_UNRESOLVED', true]],
    );
  });
});

describe('sourceProvenanceRecord', () => {
  const attempt = '0000a001-0000-4000-8000-000000000001' as Uuid4;
  const at = '2026-10-06T09:00:00.000Z' as UtcMillis;
  const source = {
    commit_sha: COMMIT_SHA,
    tree_sha: TREE_SHA,
    lockfile_path: LOCKFILE_PATH,
    lockfile_sha256: sha256Hex(new TextEncoder().encode(LOCKFILE_TEXT)),
  };

  it('states a branch, or a detached HEAD, and validates', () => {
    const validator = createRecordValidator();
    const onBranch = sourceProvenanceRecord(attempt, { ...source, branch: BRANCH }, { node: 'v24.15.0' }, at);
    assert.equal(onBranch.detached_head, false);
    assert.equal((onBranch as { readonly branch?: string }).branch, BRANCH);
    assert.equal(validator.validateAs('source_provenance', onBranch as unknown as JsonValue).valid, true);
    const detached = sourceProvenanceRecord(attempt, source, { node: 'v24.15.0' }, at);
    assert.equal(detached.detached_head, true);
    assert.equal(Object.hasOwn(detached, 'branch'), false);
    assert.equal(validator.validateAs('source_provenance', detached as unknown as JsonValue).valid, true);
  });
});
