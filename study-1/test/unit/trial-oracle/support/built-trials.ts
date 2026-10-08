// In-memory trials for the oracle and settlement suites: a golden base built by the WP-09 scenario
// builder with an optional trial plan and scenario operations (never read from disk), then
// ingested as the subject trial's evidence with the real record validator, exactly as the golden
// suites do. Each built trial is cached, so a suite builds it once.

import { ingestEvidence } from '../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence, IngestionInput } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { ingestionInputFromFiles } from '../../../golden/evidence-ingestion/ingestion-input.ts';
import type { FixtureBytes } from '../../../support/golden-builder/digest-links.ts';
import { materializeCase } from '../../../support/golden-builder/fixture-materializer.ts';
import type { BaseScenarioId, TrialPlan } from '../../../support/golden-builder/golden-plan.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { subjectDirectoryOf } from '../../../support/golden-builder/scenario-builder.ts';

/** The real catalogue validator: ingestion's and the results' schema boundary is never replaced. */
export const ORACLE_VALIDATOR: RecordValidator = createRecordValidator();

/** A trial to build: a base, optionally another plan, optionally edits. */
export interface TrialBuild {
  readonly base: BaseScenarioId;
  readonly plan?: TrialPlan;
  readonly operations?: readonly ScenarioOperation[];
}

const built = new Map<string, FixtureBytes>();

/**
 * The fixture bytes of a build; throws with every builder problem, which fails the calling test.
 *
 * @example
 * builtFiles({ base: 'run-conventional-control' }).get('runner/runner-journal.jsonl');
 */
export function builtFiles(build: TrialBuild): FixtureBytes {
  const key = JSON.stringify([build.base, build.plan ?? null, build.operations ?? []]);
  const cached = built.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const materialized = materializeCase({
    case_id: 'unit',
    ac_ids: [],
    rule_outcomes_reached: [],
    base: build.base,
    ...(build.plan === undefined ? {} : { plan: build.plan }),
    operations: build.operations ?? [],
    expected: null,
  });
  if (!materialized.ok) {
    throw new Error(`${JSON.stringify(build)} does not build: ${materialized.error.join('; ')}`);
  }
  built.set(key, materialized.value);
  return materialized.value;
}

/**
 * The ingestion input of a build's subject trial.
 *
 * @example
 * trialIngestionInput({ base: 'run-durable-control' }).expected.length;
 */
export function trialIngestionInput(build: TrialBuild): IngestionInput {
  return ingestionInputFromFiles(builtFiles(build), subjectDirectoryOf(build.base));
}

/**
 * The ingested evidence of a build's subject trial.
 *
 * @example
 * builtEvidence({ base: 'run-conventional-treatment' }).scope.trial?.scenario; // 'COMMIT_THEN_TIMEOUT'
 */
export function builtEvidence(build: TrialBuild): IngestedEvidence {
  return ingestEvidence(trialIngestionInput(build), ORACLE_VALIDATOR);
}
