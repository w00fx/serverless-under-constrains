// The README of the public redacted copy (close-out Phase 3): what the copy is, what was redacted
// and how a reader checks it against the authority. Every number in it is counted from the
// manifest and the verdict recheck by the caller, never typed by hand.

import type { RedactedPackage } from './evidence-redaction.ts';

/** One redaction rule with the files it changed and its replacements across the copy. */
export interface RuleFacts {
  readonly id: string;
  readonly description: string;
  readonly files: number;
  readonly replacements: number;
}

/** What the README states, each value counted from the manifest or the verdict recheck. */
export interface ReadmeFacts {
  readonly authority: string;
  readonly packages: readonly RedactedPackage[];
  readonly rules: readonly RuleFacts[];
  readonly file_count: number;
  readonly unchanged_count: number;
  readonly recheck_count: number;
}

/**
 * The copy's README.md text, ending with a newline.
 *
 * @example
 * writeFileSync('public/study-1-evidence/README.md', redactionReadme(facts));
 */
export function redactionReadme(facts: ReadmeFacts): string {
  const lines = [
    '# Study 1 evidence: public redacted copy',
    '',
    `A derived view of the ${String(facts.packages.length)} Study 1 evidence packages. ${facts.authority}`,
    'The raw packages stay private because they hold environment identifiers. This copy replaces',
    'those identifiers and changes nothing else.',
    '',
    '## Packages',
    '',
    '| Package | Original package-index.json SHA-256 (the authority) | Redacted package-index.json SHA-256 |',
    '|---|---|---|',
    ...facts.packages.map(
      (one) =>
        `| \`${one.directory}\` | \`${one.original_package_index_sha256}\` | \`${one.redacted_package_index_sha256}\` |`,
    ),
    '',
    '## What was redacted',
    '',
    ...facts.rules.map(
      (rule) =>
        `- \`${rule.id}\`: ${rule.description} Files changed: ${String(rule.files)}; replacements: ${String(rule.replacements)}.`,
    ),
    '',
    `${String(facts.unchanged_count)} of the ${String(facts.file_count)} files are byte-identical to the originals.`,
    '',
    '## How to check this copy',
    '',
    '1. `redaction-manifest.json` lists every file with `original_sha256`, the digest its package',
    '   index records, and `redacted_sha256`, the digest of the bytes here. A file no rule changed',
    '   has the same digest in both, so it checks directly against its package index.',
    '2. `results/study-1/results.json` cites each package by `package_index_sha256`: the original',
    '   digest in the table above.',
    `3. \`verdict-recheck.json\` re-derives the canonical run's ${String(facts.recheck_count)} verdicts from the redacted`,
    '   ledgers: BR-RUA-001, BR-RUA-002 and BR-RUA-009, and the preservation verdict, each equal to',
    '   the original oracle result.',
    '4. The owner of the raw packages re-verifies each one from its own bytes with',
    '   `npm run rua -- run verify <package>` (or `validation verify`, `probe verify`), and re-derives',
    '   this copy byte for byte with `npm run redact -- --check` in `study-1/`.',
  ];
  return `${lines.join('\n')}\n`;
}
