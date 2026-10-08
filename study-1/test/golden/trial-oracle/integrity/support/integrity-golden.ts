// The integrity goldens (design §14 rows AC-RUA-017, -018, -029, -041, -054, -055): a case's
// committed fixture is ingested as its subject trial's evidence, exactly as the production caller
// does, and evaluated by the oracle at the core goldens' fixed `checked_at`. Both outputs must hold
// their contracts before the case's expectation is compared with the same view the core goldens
// compare (`comparedView`), so the two suites read every expectation the same way.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ingestEvidence } from '../../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../../../src/evidence-ingestion/ingestion-model.ts';
import { isSha256Hex } from '../../../../../src/record-contract/digests.ts';
import type { JsonValue, Sha256Hex, StructuredReason } from '../../../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import { evaluateTrial } from '../../../../../src/trial-oracle/evaluate-trial.ts';
import type { TrialEvaluation } from '../../../../../src/trial-oracle/evaluate-trial.ts';
import { STUDY_ROOT, expectedMismatches, loadGoldenCase } from '../../../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../../_harness/golden-harness.ts';
import { ingestionInputOf } from '../../../evidence-ingestion/ingestion-input.ts';
import { CHECKED_AT, comparedView, contractViolations } from '../../core/support/oracle-golden.ts';

/** The real catalogue validator: the schema boundary is never replaced. */
export const INTEGRITY_VALIDATOR: RecordValidator = createRecordValidator();

/** The directory of the integrity cases. */
export const INTEGRITY_CASES = 'test/golden/trial-oracle/integrity/cases';

/** One integrity case evaluated: the oracle's evaluation, or its refusal. */
export interface IntegrityEvaluation {
  readonly loaded: LoadedGoldenCase;
  readonly evidence: IngestedEvidence;
  readonly evaluation:
    | { readonly ok: true; readonly value: TrialEvaluation }
    | { readonly ok: false; readonly error: readonly StructuredReason[] };
}

/**
 * Loads an integrity case, ingests its fixture and evaluates its subject trial.
 *
 * @example
 * const { evaluation } = await evaluateIntegrityCase('caller-identity-reuse');
 */
export async function evaluateIntegrityCase(caseId: string): Promise<IntegrityEvaluation> {
  return evaluateCaseFile(`${INTEGRITY_CASES}/${caseId}.case.ts`);
}

/**
 * Loads any trial case by its root-relative file and evaluates its subject trial.
 *
 * @example
 * await evaluateCaseFile('test/golden/trial-oracle/core/cases/ac005-zero-tx.case.ts');
 */
export async function evaluateCaseFile(caseFile: string): Promise<IntegrityEvaluation> {
  const loaded = await loadGoldenCase(caseFile);
  const index = await reevaluationIndexOf(caseFile);
  const input = ingestionInputOf(loaded);
  const evidence = ingestEvidence(
    index === undefined ? input : { ...input, indexed_digests: index },
    INTEGRITY_VALIDATOR,
  );
  return { loaded, evidence, evaluation: evaluateTrial({ evidence, checked_at: CHECKED_AT }) };
}

/**
 * A named export of a case module besides its case, or `undefined` when it has none.
 *
 * @example
 * await caseExport('test/golden/trial-oracle/integrity/cases/consistent.case.ts', 'monitoring');
 */
export async function caseExport(caseFile: string, name: string): Promise<unknown> {
  const module = (await import(pathToFileURL(join(STUDY_ROOT, caseFile)).href)) as Readonly<Record<string, unknown>>;
  return Object.hasOwn(module, name) ? module[name] : undefined;
}

// A case re-evaluated as a frozen package names its evidence index as `export const
// indexed_digests` (package path to SHA-256); anything else fails the test.
async function reevaluationIndexOf(caseFile: string): Promise<ReadonlyMap<string, Sha256Hex> | undefined> {
  const index = await caseExport(caseFile, 'indexed_digests');
  if (index === undefined) {
    return undefined;
  }
  const entries = typeof index === 'object' && index !== null ? Object.entries(index) : [undefined];
  const digests = entries.filter((entry): entry is [string, Sha256Hex] => isSha256Hex(entry?.[1]));
  if (digests.length !== entries.length) {
    throw new Error(`${caseFile} exports indexed_digests ${JSON.stringify(index)}; expected { path: sha256 hex }`);
  }
  return new Map(digests);
}

/**
 * Where an integrity case's evaluation departs from its contracts and its expectation. A refused
 * evaluation is compared as `{ oracle_result: 'none', refusal_codes, correct_completion: null }`
 * (BR-RUA-029 "no oracle result", BR-RUA-030 `null`), so it matches only a case expecting it.
 *
 * @example
 * assert.deepEqual(await integrityMismatches('treatment-armed'), []);
 */
export async function integrityMismatches(caseId: string): Promise<readonly string[]> {
  const { loaded, evaluation } = await evaluateIntegrityCase(caseId);
  const expected = loaded.golden_case.expected;
  if (!evaluation.ok) {
    return expectedMismatches(expected, refusalView(evaluation.error));
  }
  const actual: JsonValue = comparedView(evaluation.value, loaded.subject_directory);
  return [...contractViolations(evaluation.value), ...expectedMismatches(expected, actual)];
}

function refusalView(reasons: readonly StructuredReason[]): JsonValue {
  return { oracle_result: 'none', refusal_codes: reasons.map((reason) => reason.code), correct_completion: null };
}
