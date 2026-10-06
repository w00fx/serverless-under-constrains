// Shared steps of the probe-verdict goldens (design §12.4, §14): load a case's committed fixture,
// ingest it as the probe's evidence exactly as the production caller does (the expected artifact
// set from evidence-package's `expectedArtifactsFor`), build the probe result, and project the
// members a case's expectation names. Expected values live in the case files and come from the
// spec; this module only computes the actual side.

import { expectedArtifactsFor } from '../../../../../src/evidence-package/expected-artifacts.ts';
import { ingestEvidence } from '../../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence, IngestionInput } from '../../../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonValue, UtcMillis } from '../../../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { TransportProbeResult } from '../../../../../src/record-contract/records/group-c/transport_probe_result.ts';
import { createRecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import { buildProbeResult } from '../../../../../src/transport-qualification/verdict/probe-result.ts';
import { loadGoldenCase } from '../../../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../../_harness/golden-harness.ts';

/** The real catalogue validator: ingestion's and the result's schema boundary is never replaced. */
export const GOLDEN_VALIDATOR: RecordValidator = createRecordValidator();

/** When the probe result is checked: after the base probe's settlement (12:07:41). */
export const PROBE_CHECKED_AT = '2026-10-05T12:08:00.000Z' as UtcMillis;

/** Members whose name would claim formal ordering proof; AC-RUA-002 forbids every one. */
const HAPPENED_BEFORE_PATTERN = /happen|proof/iu;

/**
 * Loads a verdict case by id.
 *
 * @example
 * const loaded = await loadProbeCase('ac021-probe-verdict-pass');
 */
export function loadProbeCase(caseId: string): Promise<LoadedGoldenCase> {
  return loadGoldenCase(`test/golden/transport-qualification/verdict/cases/${caseId}.case.ts`);
}

/**
 * The probe's ingestion input over fixture files: every file is the probe's or execution-level.
 *
 * @example
 * probeIngestionInput(loaded.files).expected.length; // the probe's expected artifact set
 */
export function probeIngestionInput(files: ReadonlyMap<string, Uint8Array>): IngestionInput {
  // `expectedArtifactsFor` reads only `record_type` of a probe workload request.
  const request = { record_type: 'probe_workload_request' } as ProbeWorkloadRequest;
  return {
    artifacts: [...files].map(([path, bytes]) => ({ path, bytes })),
    expected: expectedArtifactsFor(request),
    execution_scope_artifacts: [],
  };
}

/**
 * Ingests fixture files as the probe's evidence with the real validator.
 *
 * @example
 * probeEvidence(loaded.files).scope.subject_kind; // 'probe'
 */
export function probeEvidence(files: ReadonlyMap<string, Uint8Array>): IngestedEvidence {
  return ingestEvidence(probeIngestionInput(files), GOLDEN_VALIDATOR);
}

/**
 * The probe result of fixture files; throws when the result cannot be built, which fails the test.
 *
 * @example
 * frozenProbeResult(loaded.files).transport_probe_verdict; // 'pass'
 */
export function frozenProbeResult(files: ReadonlyMap<string, Uint8Array>): TransportProbeResult {
  const result = buildProbeResult({ evidence: probeEvidence(files), checked_at: PROBE_CHECKED_AT });
  if (!result.ok) {
    throw new Error(`the probe result does not build: ${JSON.stringify(result.error)}; expected a result`);
  }
  return result.value;
}

/**
 * The members a verdict case names: the verdict, validity, cardinality, gates, basis, each
 * condition's result by id, BR-RUA-010's observed timestamps, the safety releases BR-RUA-014 saw,
 * and any member whose name would claim happened-before proof.
 *
 * @example
 * expectedMismatches(loaded.golden_case.expected, resultProjection(result)); // []
 */
export function resultProjection(result: TransportProbeResult): JsonValue {
  const [commitBeforeTimer, , , , controlledRelease] = result.condition_results;
  return {
    transport_probe_verdict: result.transport_probe_verdict,
    probe_validity: result.probe_validity,
    probe_cardinality: { ...result.probe_cardinality },
    evidence_integrity: result.evidence_integrity,
    treatment_fidelity: result.treatment_fidelity,
    fidelity_basis: result.fidelity_basis,
    clock_assumption_refs: [...result.clock_assumption_refs],
    ordering_basis: result.ordering_basis,
    conditions: Object.fromEntries(
      result.condition_results.map((condition) => [condition.condition_id, condition.result]),
    ),
    commit_before_timer_observed: commitBeforeTimer.observed,
    safety_release_count: memberOf(controlledRelease.observed, 'safety_release_count'),
    happened_before_members: memberNames(result as unknown as JsonValue).filter((name) =>
      HAPPENED_BEFORE_PATTERN.test(name),
    ),
  };
}

function memberOf(value: JsonValue, member: string): JsonValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, member)
    ? ((value as Readonly<Record<string, JsonValue>>)[member] ?? null)
    : null;
}

// Every member name at any depth, so a nested claim would be found too.
function memberNames(value: JsonValue): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(memberNames);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([name, member]) => [name, ...memberNames(member)]);
}
