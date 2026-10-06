// Where golden cases and their fixtures live (design §12.4): a case file
// `test/golden/<feature>/**/cases/<case-id>.case.ts` owns the sibling directory
// `fixtures/<case-id>/`, which holds the package-relative files of its evidence. Discovery is by
// glob, with no shared manifest.

/** Every case file, relative to the study root. */
export const CASE_FILE_GLOB = 'test/golden/**/cases/*.case.ts';

const CASE_FILE_PATTERN = /^(.*\/)?cases\/[^/]+\.case\.ts$/;
const CASE_SUFFIX = '.case.ts';
const CASES_SEGMENT = 'cases/';

/** Where one case's fixture lives. */
export interface CaseLocation {
  /** The case id the file name declares. */
  readonly case_id: string;
  /** The fixture directory, relative to the same root as the case file. */
  readonly fixture_directory: string;
}

/**
 * The case id and fixture directory of a case file path, or undefined when the path is not a
 * case file.
 *
 * @example
 * locateCase('test/golden/trial-oracle/cases/control-pass.case.ts');
 * // { case_id: 'control-pass', fixture_directory: 'test/golden/trial-oracle/fixtures/control-pass' }
 */
export function locateCase(caseFile: string): CaseLocation | undefined {
  const normalized = caseFile.replaceAll('\\', '/');
  if (!CASE_FILE_PATTERN.test(normalized)) {
    return undefined;
  }
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const caseId = fileName.slice(0, -CASE_SUFFIX.length);
  const parent = normalized.slice(0, normalized.length - fileName.length - CASES_SEGMENT.length);
  return { case_id: caseId, fixture_directory: `${parent}fixtures/${caseId}` };
}
