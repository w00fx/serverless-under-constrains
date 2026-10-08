// The porcelain v2 `-z` parser (BR-RUA-042): headers, every entry kind, the original path that
// follows a rename, paths with spaces, and every record it cannot read kept as malformed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGitPorcelainV2 } from '../../../src/admission/git-porcelain.ts';

const OID = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
const H = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const z = (...records: readonly string[]): string => records.map((record) => `${record}\0`).join('');

describe('parseGitPorcelainV2', () => {
  it('reads the branch headers of a clean tree', () => {
    assert.deepEqual(
      parseGitPorcelainV2(z(`# branch.oid ${OID}`, '# branch.head main', '# branch.upstream origin/main')),
      {
        commit_sha: OID,
        branch: 'main',
        detached_head: false,
        entries: [],
        malformed: [],
      },
    );
  });

  it('reads an unborn branch and a detached HEAD', () => {
    assert.deepEqual(parseGitPorcelainV2(z('# branch.oid (initial)', '# branch.head main')), {
      branch: 'main',
      detached_head: false,
      entries: [],
      malformed: [],
    });
    assert.deepEqual(parseGitPorcelainV2(z(`# branch.oid ${OID}`, '# branch.head (detached)')), {
      commit_sha: OID,
      detached_head: true,
      entries: [],
      malformed: [],
    });
  });

  it('ignores headers without a value and unknown headers', () => {
    assert.deepEqual(parseGitPorcelainV2(z('# branch.oid', '# branch.head', '# stash 2')), {
      detached_head: false,
      entries: [],
      malformed: [],
    });
  });

  it('reads changed, renamed, unmerged, untracked and ignored entries', () => {
    const output = z(
      `1 .M N... 100644 100644 100644 ${H} ${H} study-1/src/a b.ts`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 study-1/new.ts`,
      'study-1/old.ts',
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} study-1/conflict.ts`,
      '? study-1/notes.txt',
      '! study-1/cache.bin',
      `1 .M S.M. 160000 160000 160000 ${H} ${H} vendor/sub`,
    );
    assert.deepEqual(parseGitPorcelainV2(output).entries, [
      { kind: 'changed', path: 'study-1/src/a b.ts', submodule: 'N...' },
      { kind: 'renamed', path: 'study-1/new.ts', submodule: 'N...' },
      { kind: 'unmerged', path: 'study-1/conflict.ts', submodule: 'N...' },
      { kind: 'untracked', path: 'study-1/notes.txt' },
      { kind: 'ignored', path: 'study-1/cache.bin' },
      { kind: 'changed', path: 'vendor/sub', submodule: 'S.M.' },
    ]);
  });

  it('keeps a rename as the last record without its original path', () => {
    const parsed = parseGitPorcelainV2(`2 R. N... 100644 100644 100644 ${H} ${H} R100 study-1/new.ts\0`);
    assert.deepEqual(parsed.entries, [{ kind: 'renamed', path: 'study-1/new.ts', submodule: 'N...' }]);
    assert.deepEqual(parsed.malformed, []);
  });

  it('keeps unreadable records and an unterminated tail as malformed', () => {
    const parsed = parseGitPorcelainV2(
      z('1 .M N... 100644', `1 .M N... 100644 100644 100644 ${H} ${H} `, '? ', 'X something', '1x', '') + 'tail',
    );
    assert.deepEqual(parsed.entries, []);
    assert.deepEqual(parsed.malformed, [
      'tail',
      '1 .M N... 100644',
      `1 .M N... 100644 100644 100644 ${H} ${H} `,
      '? ',
      'X something',
      '1x',
      '',
    ]);
  });

  it('refuses a leading field that is empty', () => {
    assert.deepEqual(parseGitPorcelainV2(z(`1  N... 100644 100644 100644 ${H} ${H} p`)).malformed, [
      `1  N... 100644 100644 100644 ${H} ${H} p`,
    ]);
  });

  it('reads empty output as no header and no entry', () => {
    assert.deepEqual(parseGitPorcelainV2(''), { detached_head: false, entries: [], malformed: [] });
  });
});
