// The README of the public redacted copy (close-out Phase 3): the authority, the packages with both
// index digests, the verification records, each rule with its counts, what the copy re-derives and
// what it does not, and how a reader checks the copy, every number taken from the facts it is given.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactionReadme } from '../../../tools/lib/redaction-readme.ts';

describe('redactionReadme', () => {
  it('states the authority, the packages, the records, the rules, the limits and how to check the copy', () => {
    const text = redactionReadme({
      authority: 'The index digests are the authority.',
      packages: [
        { directory: 'runs/r', original_package_index_sha256: 'a1', redacted_package_index_sha256: 'b1' },
        { directory: 'transport-probes/p', original_package_index_sha256: 'a2', redacted_package_index_sha256: 'a2' },
      ],
      rules: [
        { id: 'rule-one', description: 'One becomes 1.', files: 3, replacements: 7 },
        { id: 'rule-two', description: 'Two becomes 2.', files: 0, replacements: 0 },
      ],
      file_count: 12,
      unchanged_count: 9,
      record_count: 5,
      unchanged_record_count: 3,
      recheck_count: 4,
      unchanged_ledger_count: 2,
      journal_count: 8,
      redacted_journal_count: 6,
    });
    assert.equal(
      text,
      [
        '# Study 1 evidence: public redacted copy',
        '',
        'A derived view of the 2 Study 1 evidence packages and their 5 verification records.',
        'The index digests are the authority. The raw packages stay private because they hold environment identifiers.',
        'This copy replaces those identifiers and changes nothing else.',
        '',
        '## Packages',
        '',
        '| Package | Original package-index.json SHA-256 (the authority) | Redacted package-index.json SHA-256 |',
        '|---|---|---|',
        '| `runs/r` | `a1` | `b1` |',
        '| `transport-probes/p` | `a2` | `a2` |',
        '',
        '## Verification records',
        '',
        "`verifications/<execution id>/` holds the records that the operator CLI's verify commands wrote",
        'for these packages, outside any package. `results/study-1/results.json` cites the ones it reports',
        'by path and SHA-256. 3 of the 5 records are byte-identical to the originals.',
        '',
        '## What was redacted',
        '',
        '- `rule-one`: One becomes 1. Files changed: 3; replacements: 7.',
        '- `rule-two`: Two becomes 2. Files changed: 0; replacements: 0.',
        '',
        '9 of the 12 files are byte-identical to the originals.',
        '',
        '## What this copy re-derives, and what it does not',
        '',
        '- The three monetary rules re-derive from the ledgers. `verdict-recheck.json` recomputes BR-RUA-001,',
        "  BR-RUA-002 and BR-RUA-009 and the preservation verdict for the canonical run's 4 trials",
        '  from their ledger snapshots, each equal to the original oracle result; 2 of those',
        '  4 ledger snapshots are byte-identical to the originals.',
        '- The trial-validity gates were evaluated on the private packages, not on this copy. The gates',
        '  read the trial journals, and redaction changed 6 of the 8 journal files here, so',
        "  each trial's validity in this copy is the original oracle result's, not re-derived.",
        '',
        '## How to check this copy',
        '',
        '1. `redaction-manifest.json` lists every file with `original_sha256`, the digest its package',
        '   index records, and `redacted_sha256`, the digest of the bytes here. A file no rule changed',
        '   has the same digest in both, so it checks directly against its package index.',
        '2. `results/study-1/results.json` cites each package by `package_index_sha256`: the original',
        '   digest in the table above. It cites each verification record by `path` and `sha256`: the',
        '   `original_sha256` the manifest lists for that path.',
        '3. `verdict-recheck.json` holds the recomputed rules beside the oracle result, and the ledger',
        '   digests on both sides.',
        '4. The owner of the raw packages re-verifies each one from its own bytes with',
        '   `npm run rua -- run verify <package>` (or `validation verify`, `probe verify`), and re-derives',
        '   this copy byte for byte with `npm run redact -- --check` in `study-1/`.',
        '',
      ].join('\n'),
    );
  });
});
