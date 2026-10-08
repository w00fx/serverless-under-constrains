// The frozen oracle results a late-evidence assessment reassesses (BR-RUA-043, AC-RUA-030). Each one
// is read from its exact stored bytes, so the reference the assessment records is the digest of
// what was frozen, never a digest someone claims. A result that is unreadable, invalid, stored
// elsewhere than its trial's `derived/oracle-result.json`, of another execution, or a second result
// of one trial cannot be reassessed: the assessment is refused with the reason.

import type { IngestionInput } from '../../evidence-ingestion/ingestion-model.ts';
import { namesOtherExecution } from '../../evidence-ingestion/record-correlation.ts';
import { PACKAGE_LAYOUT } from '../../evidence-package/package-layout.ts';
import { sha256Hex } from '../../record-contract/digests.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type { OracleResult } from '../../record-contract/records/group-c/oracle_result.ts';
import type { ArtifactRef, TrialExecutionIdentity } from '../../record-contract/records/group-c/shared-shapes.ts';
import type { FrozenTrialEvidence } from './late-evidence-input.ts';
import { LATE_EVIDENCE_SUBJECT, describeFirstViolation } from './late-evidence-reasons.ts';
import { activeExecution } from './late-stream-reading.ts';

/** One frozen trial whose result was read and checked. */
export interface FrozenTrial {
  readonly frozen: IngestionInput;
  readonly result: OracleResult;
  readonly result_ref: ArtifactRef;
}

/** The execution every frozen result must belong to. */
export interface FrozenExecution {
  readonly execution: TrialExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
}

/**
 * Reads every frozen trial's result, in order, or every reason one of them cannot be reassessed.
 *
 * @example
 * const trials = readFrozenTrials(input.trials, { execution: { run_id }, execution_manifest_sha256 }, validator);
 * if (trials.ok) trials.value[0]?.result.preservation_verdict;
 */
export function readFrozenTrials(
  trials: readonly FrozenTrialEvidence[],
  execution: FrozenExecution,
  validator: RecordValidator,
): Result<readonly FrozenTrial[], readonly StructuredReason[]> {
  const read: FrozenTrial[] = [];
  const reasons: StructuredReason[] = [];
  const seen = new Set<string>();
  for (const trial of trials) {
    const result = readFrozenTrial(trial, execution, validator);
    const duplicate = result.ok && seen.has(result.value.result.trial_id);
    if (!result.ok || duplicate) {
      reasons.push(result.ok ? duplicateReason(result.value) : result.error);
      continue;
    }
    seen.add(result.value.result.trial_id);
    read.push(result.value);
  }
  return reasons.length === 0 ? ok(read) : err(reasons);
}

function readFrozenTrial(
  trial: FrozenTrialEvidence,
  execution: FrozenExecution,
  validator: RecordValidator,
): Result<FrozenTrial, StructuredReason> {
  const path = trial.result.path;
  const parsed = parseJsonDocument(trial.result.bytes);
  if (!parsed.ok) {
    return err(
      frozenReason('FROZEN_RESULT_UNREADABLE', path, `${parsed.error.kind}; expected one UTF-8 JSON oracle_result`),
    );
  }
  const validation = validator.validateAs('oracle_result', parsed.value);
  if (!validation.valid) {
    const why = describeFirstViolation(validation.violations);
    return err(frozenReason('FROZEN_RESULT_INVALID', path, `${why}; expected a valid oracle_result`));
  }
  const result = validation.record as OracleResult;
  const digest = result.execution_manifest_sha256;
  if (
    namesOtherExecution(parsed.value, activeExecution(execution.execution)) ||
    digest !== execution.execution_manifest_sha256
  ) {
    const detail = `the result names another execution or execution manifest ${boundedJsonText(digest)}; expected ${execution.execution_manifest_sha256} of this execution`;
    return err(frozenReason('FROZEN_RESULT_FOREIGN', path, detail));
  }
  const expectedPath = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: result.trial_id }, 'oracleResult');
  if (path !== expectedPath) {
    return err(
      frozenReason(
        'FROZEN_RESULT_MISPLACED',
        path,
        `the result of trial ${result.trial_id} is stored at ${boundedJsonText(path)}; expected ${expectedPath}`,
      ),
    );
  }
  return ok({
    frozen: trial.frozen,
    result,
    result_ref: { artifact_path: path, artifact_sha256: sha256Hex(trial.result.bytes) },
  });
}

function duplicateReason(trial: FrozenTrial): StructuredReason {
  const detail = `trial ${trial.result.trial_id} has a second frozen result; expected one frozen result per trial`;
  return frozenReason('FROZEN_TRIAL_DUPLICATE', trial.result_ref.artifact_path, detail);
}

function frozenReason(code: string, path: string, detail: string): StructuredReason {
  return { code, subject: LATE_EVIDENCE_SUBJECT, artifact_path: path, detail };
}
