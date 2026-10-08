// Property tests of the porcelain v2 `-z` parser and step A5 (testing rule 6: a parser of
// untrusted process output; BR-RUA-042). Against a reference model of the record grammar: every
// generated status parses to exactly its entries and headers, in order, whatever the paths hold
// (spaces included); any text parses without throwing and accounts for every record; and a status
// with any entry that is not ignored never admits. Runs FC_RUNS cases per property (10,000 under
// `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parseGitPorcelainV2 } from '../../../src/admission/git-porcelain.ts';
import type { GitStatusEntry } from '../../../src/admission/git-porcelain.ts';
import { assessSourceProvenance } from '../../../src/admission/source-provenance.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const COMMIT = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';

interface ModelRecord {
  readonly records: readonly string[];
  readonly entry: GitStatusEntry;
}

const pathArbitrary = fc.string({ minLength: 1, maxLength: 24 }).filter((path) => !path.includes('\0'));
const submoduleArbitrary = fc.constantFrom('N...', 'S.M.', 'SC..', 'S..U');

const recordArbitrary: fc.Arbitrary<ModelRecord> = fc.oneof(
  pathArbitrary.map((path): ModelRecord => ({ records: [`? ${path}`], entry: { kind: 'untracked', path } })),
  pathArbitrary.map((path): ModelRecord => ({ records: [`! ${path}`], entry: { kind: 'ignored', path } })),
  fc.tuple(pathArbitrary, submoduleArbitrary).map(([path, sub]): ModelRecord => ({
    records: [`1 .M ${sub} 100644 100644 100644 ${BLOB} ${BLOB} ${path}`],
    entry: { kind: 'changed', path, submodule: sub },
  })),
  fc.tuple(pathArbitrary, pathArbitrary, submoduleArbitrary).map(([path, original, sub]): ModelRecord => ({
    records: [`2 R. ${sub} 100644 100644 100644 ${BLOB} ${BLOB} R100 ${path}`, original],
    entry: { kind: 'renamed', path, submodule: sub },
  })),
  fc.tuple(pathArbitrary, submoduleArbitrary).map(([path, sub]): ModelRecord => ({
    records: [`u UU ${sub} 100644 100644 100644 100644 ${BLOB} ${BLOB} ${BLOB} ${path}`],
    entry: { kind: 'unmerged', path, submodule: sub },
  })),
);

interface ModelHead {
  readonly header: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
}

const headArbitrary = fc.oneof(
  fc.constant<ModelHead>({ header: '(detached)', branch: undefined, detached: true }),
  fc
    .stringMatching(/^[a-z][a-z0-9/_-]{0,20}$/)
    .map((branch): ModelHead => ({ header: branch, branch, detached: false })),
);

function statusText(records: readonly string[]): string {
  return records.map((record) => `${record}\0`).join('');
}

describe('parseGitPorcelainV2 properties', () => {
  it('parses every generated status to exactly its headers and entries, in order', () => {
    fc.assert(
      fc.property(headArbitrary, fc.array(recordArbitrary, { maxLength: 12 }), (head, model) => {
        const text = statusText([
          `# branch.oid ${COMMIT}`,
          `# branch.head ${head.header}`,
          ...model.flatMap((record) => record.records),
        ]);
        const parsed = parseGitPorcelainV2(text);
        assert.equal(parsed.commit_sha, COMMIT);
        assert.equal(parsed.branch, head.branch);
        assert.equal(parsed.detached_head, head.detached);
        assert.deepEqual(
          parsed.entries,
          model.map((record) => record.entry),
        );
        assert.deepEqual(parsed.malformed, []);
      }),
      fuzzParameters(),
    );
  });

  it('parses any text without throwing and accounts for every record', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.constantFrom('? ', '1 ', '2 x', 'u ', '# ', '#')), { maxLength: 10 }),
        fc.boolean(),
        (records, terminated) => {
          const text = records.join('\0') + (terminated ? '\0' : '');
          const parsed = parseGitPorcelainV2(text);
          const recordCount = text === '' ? 0 : text.split('\0').length - (terminated ? 1 : 0);
          assert.ok(parsed.entries.length + parsed.malformed.length <= recordCount);
        },
      ),
      fuzzParameters(),
    );
  });

  it('never admits a status with an entry that is not ignored', () => {
    fc.assert(
      fc.property(fc.array(recordArbitrary, { minLength: 1, maxLength: 8 }), (model) => {
        fc.pre(model.some((record) => record.entry.kind !== 'ignored'));
        const verdict = assessSourceProvenance({
          status_porcelain_v2: statusText([
            `# branch.oid ${COMMIT}`,
            '# branch.head main',
            ...model.flatMap((record) => record.records),
          ]),
          tree_sha: COMMIT,
          in_progress: [],
          lockfile: { path: 'study-1/package-lock.json', tracked: true, bytes: new Uint8Array([123, 125]) },
        });
        assert.equal(verdict.passed, false);
      }),
      fuzzParameters(),
    );
  });
});
