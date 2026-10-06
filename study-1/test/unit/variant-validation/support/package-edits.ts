// Editing one record of a golden package's files: parse the stored bytes, change members, and store
// the canonical serialization again, the way a writer that froze the edited record would have.

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { fileAtPath, replaceFile } from '../../../golden/variant-validation/support/golden-files.ts';

/** The JSON members of a stored record, as plain values. */
export type RecordMembers = Record<string, unknown>;

/**
 * `files` with the record at `path` replaced by `edit` of its parsed members.
 *
 * @example
 * editRecord(files, 'summary/validation-summary.json', (summary) => ({ ...summary, variant_id: 'conventional' }));
 */
export function editRecord(
  files: readonly PackageFile[],
  path: string,
  edit: (members: RecordMembers) => RecordMembers,
): readonly PackageFile[] {
  const members = JSON.parse(new TextDecoder().decode(fileAtPath(files, path).bytes)) as RecordMembers;
  return replaceFile(files, path, serializeRecordFile(edit(members) as unknown as StudyRecord));
}

/**
 * The parsed members of the record at `path`.
 *
 * @example
 * recordAt(files, 'summary/validation-summary.json')['implementation_validation_status'];
 */
export function recordAt(files: readonly PackageFile[], path: string): RecordMembers {
  return JSON.parse(new TextDecoder().decode(fileAtPath(files, path).bytes)) as RecordMembers;
}
