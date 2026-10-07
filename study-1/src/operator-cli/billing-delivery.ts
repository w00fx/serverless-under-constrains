// The check of one local billing delivery before `billing import` reads it (design §8.17;
// BR-RUA-047; WP-18 review residual: `buildBillingImport` sees one data file, so a delivery split
// across several files must never be imported as if it were whole). The operator copies one Data
// Exports delivery into a directory; the directory is untrusted input (A-05), so this check is
// total over any listing and any manifest bytes, and it never throws.
//
// Refused outright (nothing is written, exit 5):
// - an entry that is not a regular file, or a path that cannot be stored under
//   `payload/billing-export/` (BR-RUA-035);
// - not exactly one manifest file (`*Manifest.json`), or a manifest that is not one JSON object;
// - a manifest that does not list exactly one data file, or a listed file that is not exactly one
//   delivered file other than the manifest itself, or any delivered file the manifest does not list.
// Read but `unverified` (the amendment is still written, with these reasons):
// - a billing period the manifest does not state readably, or one that does not contain the
//   execution's attribution window (INCOMPLETE_PERIOD);
// - a payer/usage-account scope that does not include the execution's frozen 12-digit account
//   (INCOMPLETE_ATTRIBUTION).
// UNVERIFIED (cloud phase): the Data Exports manifest member names below are not yet confirmed
// against a real delivery; they are constants so the confirmation edits one place, and every
// member that is absent or unreadable fails closed (refused or `unverified`, never verified).

import { unverifiedReason } from '../billing-amendment/unverified-reasons.ts';
import type { UsageInterval } from '../billing-amendment/usage-window.ts';
import { isContained, parseCurTimestamp } from '../billing-amendment/usage-window.ts';
import { invalidPathReason } from '../evidence-package/artifact-classification.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import { boundedJsonText, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { BillingUnverifiedReason } from '../record-contract/records/group-c/billing_import.ts';

/** The suffix that names a delivery's manifest file (UNVERIFIED, cloud phase). */
export const DELIVERY_MANIFEST_SUFFIX = 'Manifest.json';

/** The Data Exports manifest members this check reads (UNVERIFIED, cloud phase). */
export const DELIVERY_MANIFEST_MEMBERS = {
  /** An array of the delivery's data file keys or URIs. */
  dataFiles: 'dataFiles',
  /** An object with `start` and `end` instants. */
  billingPeriod: 'billingPeriod',
  periodStart: 'start',
  periodEnd: 'end',
  /** The payer account id. */
  payerAccount: 'account',
  /** The usage (linked) account ids the delivery covers. */
  usageAccounts: 'usageAccountIds',
} as const;

/** One entry of the delivery directory, at its POSIX path relative to it. */
export interface DeliveryEntry {
  readonly path: string;
  /** Exact bytes of a regular file; absent for any other entry type. */
  readonly bytes?: Uint8Array;
}

/** The delivered file, kept as exact bytes. */
export interface DeliveredFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What the delivery offers, and why its scope or period leaves the import `unverified`. */
export interface CheckedDelivery {
  readonly manifest: DeliveredFile;
  readonly data_file: DeliveredFile;
  readonly reasons: readonly BillingUnverifiedReason[];
}

/** What the delivery must cover: the frozen account and the attribution window. */
export interface DeliveryExpectations {
  readonly account_id: string;
  readonly window: UsageInterval;
}

const SUBJECT = 'BR-RUA-047';

/**
 * Checks one delivery directory; its manifest and only data file, or why it cannot be imported.
 *
 * @example
 * const checked = checkDelivery(entries, { account_id: '012345678901', window });
 * if (checked.ok) buildBillingImport({ ...input, export_bytes: checked.value.data_file.bytes });
 */
export function checkDelivery(
  entries: readonly DeliveryEntry[],
  expectations: DeliveryExpectations,
): Result<CheckedDelivery, StructuredReason> {
  const files = deliveredFiles(entries);
  if (!files.ok) {
    return files;
  }
  const manifests = files.value.filter((file) => file.path.endsWith(DELIVERY_MANIFEST_SUFFIX));
  const [manifest] = manifests;
  if (manifest === undefined || manifests.length !== 1) {
    return err(refusal(`${String(manifests.length)} manifest files`, `exactly one *${DELIVERY_MANIFEST_SUFFIX}`));
  }
  const parsed = parseJsonDocument(manifest.bytes);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return err(refusal(`${boundedJsonText(manifest.path)} is not one JSON object`, 'a Data Exports manifest object'));
  }
  const dataFile = listedDataFile(parsed.value, files.value, manifest.path);
  if (!dataFile.ok) {
    return dataFile;
  }
  return ok({
    manifest,
    data_file: dataFile.value,
    reasons: [
      ...periodReasons(parsed.value, expectations.window),
      ...scopeReasons(parsed.value, expectations.account_id),
    ],
  });
}

// Every entry a regular file whose path can be stored under the amendment's export directory.
function deliveredFiles(entries: readonly DeliveryEntry[]): Result<readonly DeliveredFile[], StructuredReason> {
  const files: DeliveredFile[] = [];
  for (const entry of entries) {
    const invalid = invalidPathReason(`${AMENDMENT_PATHS.billingExportDirectory}${entry.path}`);
    if (entry.bytes === undefined || invalid !== undefined) {
      const problem = entry.bytes === undefined ? 'is not a regular file' : 'cannot be stored as a package path';
      return err(
        refusal(
          `delivery entry ${boundedJsonText(entry.path)} ${problem}`,
          'regular files at normalized relative paths',
        ),
      );
    }
    files.push({ path: entry.path, bytes: entry.bytes });
  }
  return ok(files);
}

// The one data file the manifest lists, delivered exactly once, with nothing else unlisted.
function listedDataFile(
  manifest: JsonObject,
  files: readonly DeliveredFile[],
  manifestPath: string,
): Result<DeliveredFile, StructuredReason> {
  const listed = ownMember(manifest, DELIVERY_MANIFEST_MEMBERS.dataFiles);
  const keys = isJsonArray(listed) ? listed : [];
  const [key] = keys;
  if (typeof key !== 'string' || keys.length !== 1 || key === '') {
    return err(
      refusal(
        `${boundedJsonText(manifestPath)} member ${DELIVERY_MANIFEST_MEMBERS.dataFiles} is ${boundedJsonText(listed ?? null)}`,
        'an array of exactly one data file key',
      ),
    );
  }
  // The manifest is never its own data file (fuzz regression: seed 437808079, a self-listing manifest).
  const matches = files.filter(
    (file) => file.path !== manifestPath && (key === file.path || key.endsWith(`/${file.path}`)),
  );
  const [match] = matches;
  if (match === undefined || matches.length !== 1) {
    return err(
      refusal(
        `the listed data file ${boundedJsonText(key)} matches ${String(matches.length)} delivered files`,
        'exactly one',
      ),
    );
  }
  const unlisted = files.find((file) => file.path !== match.path && file.path !== manifestPath);
  return unlisted === undefined
    ? ok(match)
    : err(
        refusal(
          `delivered file ${boundedJsonText(unlisted.path)} is not listed`,
          'only the manifest and its one data file',
        ),
      );
}

function periodReasons(manifest: JsonObject, window: UsageInterval): readonly BillingUnverifiedReason[] {
  const period = ownMember(manifest, DELIVERY_MANIFEST_MEMBERS.billingPeriod);
  const start = isJsonObject(period) ? instantOf(ownMember(period, DELIVERY_MANIFEST_MEMBERS.periodStart)) : undefined;
  const end = isJsonObject(period) ? instantOf(ownMember(period, DELIVERY_MANIFEST_MEMBERS.periodEnd)) : undefined;
  if (start === undefined || end === undefined) {
    return [
      unverifiedReason(
        'INCOMPLETE_PERIOD',
        `the delivery manifest states its ${DELIVERY_MANIFEST_MEMBERS.billingPeriod} as ${boundedJsonText(period ?? null)}, not as readable UTC instants`,
      ),
    ];
  }
  return isContained(window, { start, end })
    ? []
    : [
        unverifiedReason(
          'INCOMPLETE_PERIOD',
          `the delivery covers ${start} to ${end}, not the attribution window ${window.start} to ${window.end}`,
        ),
      ];
}

function scopeReasons(manifest: JsonObject, accountId: string): readonly BillingUnverifiedReason[] {
  const payer = ownMember(manifest, DELIVERY_MANIFEST_MEMBERS.payerAccount);
  const usage = ownMember(manifest, DELIVERY_MANIFEST_MEMBERS.usageAccounts);
  const scope = [payer, ...(isJsonArray(usage) ? usage : [])];
  return scope.includes(accountId)
    ? []
    : [
        unverifiedReason(
          'INCOMPLETE_ATTRIBUTION',
          `the delivery's account scope (${DELIVERY_MANIFEST_MEMBERS.payerAccount} ${boundedJsonText(payer ?? null)}, ${DELIVERY_MANIFEST_MEMBERS.usageAccounts} ${boundedJsonText(usage ?? null)}) does not include the frozen account ${accountId}`,
        ),
      ];
}

function instantOf(value: JsonValue | undefined): UtcMillis | undefined {
  return typeof value === 'string' ? parseCurTimestamp(value) : undefined;
}

// Own members only: a manifest naming `__proto__` or `constructor` never reaches an inherited value.
function ownMember(object: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

function refusal(problem: string, expected: string): StructuredReason {
  return { code: 'BILLING_DELIVERY_REFUSED', subject: SUBJECT, detail: `${problem}; expected ${expected}` };
}
