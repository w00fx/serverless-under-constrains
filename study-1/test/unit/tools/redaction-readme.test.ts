// The README of the public redacted copy (close-out Phase 3): the authority, the packages with both
// index digests, each rule with its counts, and how a reader checks the copy, every number taken
// from the facts it is given.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactionReadme } from '../../../tools/lib/redaction-readme.ts';

describe('redactionReadme', () => {
  it('states the authority, the packages, the rules with their counts and how to check the copy', () => {
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
      recheck_count: 4,
    });
    assert.equal(
      text,
      [
        '# Study 1 evidence: public redacted copy',
        '',
        'A derived view of the 2 Study 1 evidence packages. The index digests are the authority.',
        'The raw packages stay private because they hold environment identifiers. This copy replaces',
        'those identifiers and changes nothing else.',
        '',
        '## Packages',
        '',
        '| Package | Original package-index.json SHA-256 (the authority) | Redacted package-index.json SHA-256 |',
        '|---|---|---|',
        '| `runs/r` | `a1` | `b1` |',
        '| `transport-probes/p` | `a2` | `a2` |',
        '',
        '## What was redacted',
        '',
        '- `rule-one`: One becomes 1. Files changed: 3; replacements: 7.',
        '- `rule-two`: Two becomes 2. Files changed: 0; replacements: 0.',
        '',
        '9 of the 12 files are byte-identical to the originals.',
        '',
        '## How to check this copy',
        '',
        '1. `redaction-manifest.json` lists every file with `original_sha256`, the digest its package',
        '   index records, and `redacted_sha256`, the digest of the bytes here. A file no rule changed',
        '   has the same digest in both, so it checks directly against its package index.',
        '2. `results/study-1/results.json` cites each package by `package_index_sha256`: the original',
        '   digest in the table above.',
        "3. `verdict-recheck.json` re-derives the canonical run's 4 verdicts from the redacted",
        '   ledgers: BR-RUA-001, BR-RUA-002 and BR-RUA-009, and the preservation verdict, each equal to',
        '   the original oracle result.',
        '4. The owner of the raw packages re-verifies each one from its own bytes with',
        '   `npm run rua -- run verify <package>` (or `validation verify`, `probe verify`), and re-derives',
        '   this copy byte for byte with `npm run redact -- --check` in `study-1/`.',
        '',
      ].join('\n'),
    );
  });
});
