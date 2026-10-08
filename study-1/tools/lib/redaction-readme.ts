// The README of the public redacted copy (close-out Phase 3): what the copy is, what was redacted,
// what the copy can re-derive and what it cannot, and how a reader checks it against the
// authority. Every number in it is counted from the manifest and the verdict recheck by the
// caller, never typed by hand.

import { ARCHIVE_NAME } from './evidence-archive.ts';
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
  readonly record_count: number;
  readonly unchanged_record_count: number;
  readonly recheck_count: number;
  readonly unchanged_ledger_count: number;
  readonly journal_count: number;
  readonly redacted_journal_count: number;
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
    `A derived view of the ${String(facts.packages.length)} Study 1 evidence packages and their ${String(facts.record_count)} verification records.`,
    `${facts.authority} The raw packages stay private because they hold environment identifiers.`,
    'This copy replaces those identifiers and changes nothing else.',
    '',
    `The package files and the verification records are in \`${ARCHIVE_NAME}\`. Extract it here with`,
    `\`tar -xzf ${ARCHIVE_NAME}\`: it restores every path that this README and \`redaction-manifest.json\``,
    'name. Git ignores the extracted folders.',
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
    '## Verification records',
    '',
    "`verifications/<execution id>/` holds the records that the operator CLI's verify commands wrote",
    'for these packages, outside any package. `results/study-1/results.json` cites the ones it reports',
    `by path and SHA-256. ${String(facts.unchanged_record_count)} of the ${String(facts.record_count)} records are byte-identical to the originals.`,
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
    '## What this copy re-derives, and what it does not',
    '',
    `- The three monetary rules re-derive from the ledgers. \`verdict-recheck.json\` recomputes BR-RUA-001,`,
    `  BR-RUA-002 and BR-RUA-009 and the preservation verdict for the canonical run's ${String(facts.recheck_count)} trials`,
    `  from their ledger snapshots, each equal to the original oracle result; ${String(facts.unchanged_ledger_count)} of those`,
    `  ${String(facts.recheck_count)} ledger snapshots are byte-identical to the originals.`,
    '- The trial-validity gates were evaluated on the private packages, not on this copy. The gates',
    `  read the trial journals, and redaction changed ${String(facts.redacted_journal_count)} of the ${String(facts.journal_count)} journal files here, so`,
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
    '   this copy byte for byte with `npm run redact -- --check` in `study-1/`. The check compares the',
    '   archive after decompression, because gzip output can differ between zlib builds.',
  ];
  return `${lines.join('\n')}\n`;
}
