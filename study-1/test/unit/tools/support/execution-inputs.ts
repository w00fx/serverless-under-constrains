// Execution inputs for the derived Study 1 results tests: a run, a counted validation and an
// indeterminate validation, each built in an in-memory evidence root, plus the edits the refusal
// tests apply to them.

import type { ExecutionInput, LooseFile } from '../../../../tools/lib/study-results-execution.ts';
import type { EditableRecord, FileMap } from './in-memory-evidence.ts';
import {
  bytesOf,
  CONTROL_CONVENTIONAL,
  editableIn,
  executionFiles,
  InMemoryEvidence,
  RUN_ID,
  TIMEOUT_DURABLE,
  VALIDATION_ID,
} from './in-memory-evidence.ts';

export const LIMITATION_9 =
  'Variant-validation evidence is non-comparative and cannot substitute for the canonical four-cell run.';
export const RUN_DIRECTORY = `runs/${RUN_ID}`;
export const VALIDATION_DIRECTORY = `variant-validations/${VALIDATION_ID}`;
export const VALIDATION_SUMMARY = 'summary/validation-summary.json';

/** A verify output under the execution's verifications folder, named by its record type. */
export function verificationOf(id: string, record: EditableRecord): LooseFile {
  return {
    path: `verifications/${id}/2026-10-07T06:00:00.000Z-${String(record['record_type'])}.json`,
    bytes: bytesOf(record),
  };
}

/** A run of a conventional CONTROL and a Durable COMMIT_THEN_TIMEOUT trial, stored in `evidence`. */
export function runInput(
  evidence: InMemoryEvidence,
  verifications: (index: string) => readonly LooseFile[] = () => [],
): ExecutionInput {
  evidence.putPackage(RUN_DIRECTORY, executionFiles('run', RUN_ID, [CONTROL_CONVENTIONAL, TIMEOUT_DURABLE]));
  return {
    kind: 'run',
    id: RUN_ID,
    read: evidence.read,
    verifications: verifications(evidence.indexDigest(RUN_DIRECTORY)),
  };
}

/** A one-trial run whose files a test edits before they are indexed. */
export function editedRun(change: (files: FileMap) => void): ExecutionInput {
  const evidence = new InMemoryEvidence();
  const files = executionFiles('run', RUN_ID, [CONTROL_CONVENTIONAL]);
  change(files);
  evidence.putPackage(RUN_DIRECTORY, files);
  return { kind: 'run', id: RUN_ID, read: evidence.read, verifications: [] };
}

/** A one-trial Durable validation stored in `evidence`, its trial and summary files edited first. */
export function validationInput(
  evidence: InMemoryEvidence,
  editTrials?: (files: FileMap) => void,
  editSummary: (summary: EditableRecord) => void = () => undefined,
): ExecutionInput {
  const files = executionFiles('variant_validation', VALIDATION_ID, [TIMEOUT_DURABLE], editTrials);
  summaryEdit(editSummary, VALIDATION_SUMMARY)(files);
  evidence.putPackage(VALIDATION_DIRECTORY, files);
  return { kind: 'variant_validation', id: VALIDATION_ID, read: evidence.read, verifications: [] };
}

/** A Durable validation whose trial the oracle could not conclude, as eda6019a's. */
export function indeterminateValidationInput(evidence: InMemoryEvidence): ExecutionInput {
  const oraclePath = `trials/${TIMEOUT_DURABLE.id}/derived/oracle-result.json`;
  const inconclusive = (files: FileMap): void => {
    const oracle = editableIn(files, oraclePath);
    oracle['preservation_verdict'] = 'indeterminate';
    oracle['trial_validity'] = 'indeterminate';
    oracle['validity_gates'] = [
      { gate: 'independent_oracle', value: 'unverified' },
      { gate: 'traceability', value: 'verified' },
      { gate: 'control_integrity', value: 'not_applicable' },
      { gate: 'settlement', value: 'invalid' },
    ];
    oracle['indeterminate_reasons'] = [
      { code: 'SETTLEMENT_NOT_ESTABLISHED' },
      { code: 'INNER_EXECUTION_ACTIVE' },
      { code: 'SETTLEMENT_NOT_ESTABLISHED' },
    ];
    files.set(oraclePath, oracle);
  };
  return validationInput(evidence, inconclusive, (summary) => {
    summary['implementation_validation_status'] = 'indeterminate';
    summary['validation_validity'] = 'indeterminate';
    summary['status_reasons'] = [
      { code: 'TRIAL_NOT_VALID', subject: 'trial 1', detail: 'trial_validity is indeterminate' },
    ];
  });
}

/** An edit of one summary file of a package. */
export function summaryEdit(
  change: (summary: EditableRecord) => void,
  path = 'summary/run-summary.json',
): (files: FileMap) => void {
  return (files) => {
    const summary = editableIn(files, path);
    change(summary);
    files.set(path, summary);
  };
}
