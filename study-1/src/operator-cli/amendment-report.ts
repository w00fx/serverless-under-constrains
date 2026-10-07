// How a command that writes one amendment reports it (design §7 amendments, §11; BR-RUA-043): the
// written path is the amendment's index, the file written last, below the evidence root; a refusal
// is `verification_failed` (exit 5) unless it only says the amendment could not be stored, which is
// an evidence-finalization failure (exit 10).

import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import type { ExecutionIdentity, StructuredReason } from '../record-contract/primitives.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliOutcomeReport } from './cli-types.ts';

// `writeAmendmentPackage` codes for an amendment chain that could not be read or written.
const STORAGE_FAILURES: ReadonlySet<string> = new Set(['AMENDMENT_NOT_WRITTEN', 'AMENDMENTS_UNREADABLE']);

/**
 * The written path of an amendment: its index, below the evidence root.
 *
 * @example
 * amendmentWrittenPath('amendments/<id>/0001-<a>'); // 'amendments/<id>/0001-<a>/amendment-index.json'
 */
export function amendmentWrittenPath(directory: string): string {
  return `${directory}/${AMENDMENT_PATHS.amendmentIndex}`;
}

/**
 * The report of an amendment service's refusal.
 *
 * @example
 * amendmentRefusal(identity, [{ code: 'PACKAGE_NOT_FINALIZED', … }]).outcome; // 'verification_failed'
 */
export function amendmentRefusal(execution: ExecutionIdentity, reasons: readonly StructuredReason[]): CliOutcomeReport {
  const storage = reasons.some((reason) => STORAGE_FAILURES.has(reason.code));
  return { ...failedOutcome(storage ? 'internal_failure' : 'verification_failed', reasons), execution };
}
