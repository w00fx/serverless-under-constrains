// The public redacted copy of the Study 1 packages (close-out Phase 3). Spec limitation 10: a
// private raw package may contain environment identifiers, and any public redaction is a
// separately derived artifact. The copy rewrites only the owner's environment identifiers, the AWS
// account id and local filesystem paths, and each original package-index.json digest stays the
// authority: the manifest maps every file's original digest to its redacted one with the rules
// applied. A copy that still holds an identifier, or whose JSON no longer parses, is refused.

import { sha256Hex } from '../../src/record-contract/digests.ts';
import { decodeUtf8Strict, parseJsonDocument, parseJsonl } from '../../src/record-contract/parsing.ts';
import type { TrialRecheck } from './redacted-verdicts.ts';
import { recheckRunVerdicts } from './redacted-verdicts.ts';
import type { ReadmeFacts } from './redaction-readme.ts';
import { redactionReadme } from './redaction-readme.ts';
import type { EvidenceFileReader, EvidencePackage } from './study-results-reading.ts';
import { loadPackage } from './study-results-reading.ts';

export type RedactionRuleId = 'aws-account-id' | 'checkout-path' | 'home-path' | 'temp-path';

/** The AWS documentation's example account id: still twelve digits, so every ARN keeps its shape. */
export const ACCOUNT_PLACEHOLDER = '111122223333';

export const REDACTION_RULE_IDS: readonly RedactionRuleId[] = [
  'aws-account-id',
  'checkout-path',
  'home-path',
  'temp-path',
];

export const REDACTION_RULES: Readonly<Record<RedactionRuleId, string>> = {
  'aws-account-id': `The AWS account id that the ARN account segments name becomes ${ACCOUNT_PLACEHOLDER} wherever it appears: ARNs, bucket names, queue URLs and plain values.`,
  'checkout-path': 'An absolute path through the local repository checkout becomes <checkout>/, kept from study-1/ on.',
  'home-path': 'Any other /Users/<name> or /home/<name> prefix becomes <home>.',
  'temp-path': 'A macOS temporary directory, /var/folders/<a>/<b>/T with or without /private, becomes <temp-dir>.',
};

/** The rules that changed one file, each with its number of replacements. */
export type RulesApplied = Readonly<Partial<Record<RedactionRuleId, number>>>;

export interface RedactedText {
  readonly text: string;
  readonly rules_applied: RulesApplied;
}

/** One file of the copy, by its path relative to the evidence root, with both digests. */
export interface RedactionEntry {
  readonly path: string;
  readonly original_sha256: string;
  readonly redacted_sha256: string;
  readonly rules_applied: RulesApplied;
}

/** One package of the copy: its original identity beside the digest of its redacted index. */
export interface RedactedPackage {
  readonly directory: string;
  readonly original_package_index_sha256: string;
  readonly redacted_package_index_sha256: string;
}

export interface RedactionManifest {
  readonly record_type: 'redaction_manifest';
  readonly schema_version: 1;
  readonly derived_by: string;
  readonly authority: string;
  readonly rules: Readonly<Record<RedactionRuleId, string>>;
  readonly packages: readonly RedactedPackage[];
  readonly files: readonly RedactionEntry[];
}

/** The derived copy: every output file by its path in the copy directory. */
export interface RedactedCopy {
  readonly manifest: RedactionManifest;
  readonly rechecks: readonly TrialRecheck[];
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** The packages to copy, as directories under the evidence root, and how to read them. */
export interface RedactionInput {
  readonly packages: readonly string[];
  readonly read: EvidenceFileReader;
}

/** One original file: its path relative to the evidence root, its indexed digest and its text. */
interface SourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

/** One file of the copy: its redacted bytes and its manifest entry. */
interface RedactedFile {
  readonly bytes: Uint8Array;
  readonly entry: RedactionEntry;
}

/** One package's files, its index first, as read or as redacted. */
interface PackageFiles<T> {
  readonly pkg: EvidencePackage;
  readonly index: T;
  readonly files: readonly T[];
}

type Rule = readonly [RedactionRuleId, RegExp, string];

const ARN_WITH_ACCOUNT = /arn:aws[\w-]*:[\w-]*:[\w-]*:\d{12}:/g;
const PACKAGE_DIRECTORY =
  /^(?:runs|transport-probes|variant-validations)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEFTOVER_PATH = /\/(?:Users|home|var\/folders)\//;
// Order matters: the checkout rule keeps the study-1/ tail before the home rule takes the rest.
const PATH_RULES: readonly Rule[] = [
  ['checkout-path', /\/(?:Users|home)\/[\w.-]+(?:\/[\w.-]+)*?\/(?=study-1\/)/g, '<checkout>/'],
  ['home-path', /\/(?:Users|home)\/[\w.-]+/g, '<home>'],
  ['temp-path', /(?:\/private)?\/var\/folders\/[\w.-]+\/[\w.-]+\/T(?=\/)/g, '<temp-dir>'],
];

/**
 * The derived public copy of `packages`: every indexed file redacted and checked, the manifest,
 * the run verdicts re-derived from the redacted ledgers, and the README.
 *
 * @example
 * deriveRedactedCopy({ packages: ['runs/<id>'], read }).files.get('redaction-manifest.json');
 */
export function deriveRedactedCopy(input: RedactionInput): RedactedCopy {
  assertPackageDirectories(input.packages);
  const sources = input.packages.map((directory) => sourcesOf(loadPackage(directory, input.read), input.read));
  const accountId = accountIdOf(sources.flatMap((one) => [one.index, ...one.files]).map((source) => source.text));
  const redacted = sources.map((one) => ({
    pkg: one.pkg,
    index: redactSource(one.index, accountId),
    files: one.files.map((source) => redactSource(source, accountId)),
  }));
  const copied = redacted.flatMap((one) => [one.index, ...one.files]);
  const files = new Map(copied.map((file) => [file.entry.path, file.bytes]));
  const manifest: RedactionManifest = {
    record_type: 'redaction_manifest',
    schema_version: 1,
    derived_by: 'study-1/tools/redact-evidence.ts',
    authority:
      'Each original package-index.json digest is the authority; this copy is a derived view of the packages (spec limitation 10).',
    rules: REDACTION_RULES,
    packages: redacted.map((one) => ({
      directory: one.pkg.directory,
      original_package_index_sha256: one.pkg.index_sha256,
      redacted_package_index_sha256: one.index.entry.redacted_sha256,
    })),
    files: copied.map((file) => file.entry),
  };
  const rechecks = redacted
    .filter((one) => one.pkg.directory.startsWith('runs/'))
    .flatMap((one) => recheckRunVerdicts(one.pkg, (path) => files.get(path)));
  const encoder = new TextEncoder();
  files.set('redaction-manifest.json', encoder.encode(jsonText(manifest)));
  files.set('verdict-recheck.json', encoder.encode(jsonText(rechecks)));
  files.set('README.md', encoder.encode(redactionReadme(readmeFacts(manifest, rechecks))));
  return { manifest, rechecks, files };
}

/**
 * Refuses package directories that are not `<kind>/<lowercase UUID>` under the evidence root, or
 * that repeat, so no path can leave the evidence root.
 *
 * @example
 * assertPackageDirectories(['runs/abf41ffd-3008-4b29-81ee-b65d8095188b']);
 */
export function assertPackageDirectories(directories: readonly string[]): void {
  const malformed = directories.filter((directory) => !PACKAGE_DIRECTORY.test(directory));
  const repeated = directories.filter((directory, index) => directories.indexOf(directory) !== index);
  if (directories.length === 0 || malformed.length > 0 || repeated.length > 0) {
    throw new Error(
      `got packages ${JSON.stringify(directories)}; expected at least one distinct ` +
        '{runs|transport-probes|variant-validations}/<lowercase UUID> directory',
    );
  }
}

/**
 * The one AWS account id that the texts' ARN account segments name, refused when they name none or
 * more than one.
 *
 * @example
 * accountIdOf(['arn:aws:sqs:us-east-1:123456789012:queue']); // '123456789012'
 */
export function accountIdOf(texts: readonly string[]): string {
  const ids = [
    ...new Set(texts.flatMap((text) => [...text.matchAll(ARN_WITH_ACCOUNT)].map((match) => match[0].slice(-13, -1)))),
  ].sort();
  const [only, ...others] = ids;
  if (only === undefined || others.length > 0) {
    throw new Error(`the ARNs name accounts ${JSON.stringify(ids)}; expected exactly one, the study's sandbox`);
  }
  return only;
}

/**
 * `text` with every rule applied in order, and how many replacements each rule made.
 *
 * @example
 * redactText('arn:aws:sqs:us-east-1:123456789012:q', '123456789012').text; // 'arn:aws:sqs:us-east-1:111122223333:q'
 */
export function redactText(text: string, accountId: string): RedactedText {
  const rules: readonly Rule[] = [
    ['aws-account-id', new RegExp(`(?<!\\d)${accountId}(?!\\d)`, 'g'), ACCOUNT_PLACEHOLDER],
    ...PATH_RULES,
  ];
  const applied: Partial<Record<RedactionRuleId, number>> = {};
  let redacted = text;
  for (const [rule, pattern, placeholder] of rules) {
    redacted = redacted.replace(pattern, () => {
      applied[rule] = (applied[rule] ?? 0) + 1;
      return placeholder;
    });
  }
  return { text: redacted, rules_applied: applied };
}

/**
 * What a redaction rule should have removed and `text` still holds: the account id anywhere, even
 * inside a longer number, or a local path prefix. Empty for a clean text.
 *
 * @example
 * leaksIn('<home>/x', '123456789012'); // []
 */
export function leaksIn(text: string, accountId: string): readonly string[] {
  const leaks = text.includes(accountId) ? [`the account id ${accountId}`] : [];
  const path = LEFTOVER_PATH.exec(text);
  return path === null ? leaks : [...leaks, `the local path prefix ${path[0]}`];
}

function sourcesOf(pkg: EvidencePackage, read: EvidenceFileReader): PackageFiles<SourceFile> {
  const indexPath = `${pkg.directory}/package-index.json`;
  const files = [...pkg.files.values()].map((file) => {
    const path = `${pkg.directory}/${file.path}`;
    return { path, sha256: file.sha256, text: textOf(file.bytes, path) };
  });
  return { pkg, index: { path: indexPath, sha256: pkg.index_sha256, text: textOf(read(indexPath), indexPath) }, files };
}

function textOf(bytes: Uint8Array, path: string): string {
  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) {
    throw new Error(`${path} is not UTF-8 at byte ${String(decoded.error.byte_offset)}; expected UTF-8 text`);
  }
  return decoded.value;
}

function redactSource(source: SourceFile, accountId: string): RedactedFile {
  const redacted = redactText(source.text, accountId);
  const leaks = leaksIn(redacted.text, accountId);
  if (leaks.length > 0) {
    throw new Error(`redacted ${source.path} still holds ${leaks.join(' and ')}; expected no environment identifier`);
  }
  const bytes = new TextEncoder().encode(redacted.text);
  assertParses(source.path, bytes);
  return {
    bytes,
    entry: {
      path: source.path,
      original_sha256: source.sha256,
      redacted_sha256: sha256Hex(bytes),
      rules_applied: redacted.rules_applied,
    },
  };
}

function assertParses(path: string, bytes: Uint8Array): void {
  const valid = path.endsWith('.jsonl')
    ? parseJsonl(bytes).lines.every((line) => line.parsed.ok)
    : !path.endsWith('.json') || parseJsonDocument(bytes).ok;
  if (!valid) {
    throw new Error(`redacted ${path} does not parse; expected the JSON of the original file`);
  }
}

function readmeFacts(manifest: RedactionManifest, rechecks: readonly TrialRecheck[]): ReadmeFacts {
  return {
    authority: manifest.authority,
    packages: manifest.packages,
    rules: REDACTION_RULE_IDS.map((id) => {
      const counts = manifest.files.map((file) => file.rules_applied[id] ?? 0);
      return {
        id,
        description: REDACTION_RULES[id],
        files: counts.filter((count) => count > 0).length,
        replacements: counts.reduce((total, count) => total + count, 0),
      };
    }),
    file_count: manifest.files.length,
    unchanged_count: manifest.files.filter((file) => file.original_sha256 === file.redacted_sha256).length,
    recheck_count: rechecks.length,
  };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
