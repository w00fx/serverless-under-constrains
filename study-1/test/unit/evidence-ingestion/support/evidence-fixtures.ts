// In-memory evidence for the ingestion unit suites: a golden base built by the WP-09 scenario
// builder (never read from disk), optionally edited by golden operations, then split into an
// ingestion input exactly as the golden suite does. Each built base is cached, so a suite builds
// it once.

import { expectedArtifactsFor } from '../../../../src/evidence-package/expected-artifacts.ts';
import { ingestEvidence } from '../../../../src/evidence-ingestion/ingest-evidence.ts';
import type {
  IngestedEvidence,
  IngestionInput,
  RawArtifact,
} from '../../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { materializeCase } from '../../../support/golden-builder/fixture-materializer.ts';
import type { BaseScenarioId } from '../../../support/golden-builder/golden-plan.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { subjectDirectoryOf } from '../../../support/golden-builder/scenario-builder.ts';
import { ingestionInputFromFiles } from '../../../golden/evidence-ingestion/ingestion-input.ts';

/** The real kernel validator: ingestion's schema boundary is never replaced. */
export const VALIDATOR = createRecordValidator();

const built = new Map<string, ReadonlyMap<string, Uint8Array>>();
const encoder = new TextEncoder();

/**
 * The fixture bytes of a base after `operations`.
 *
 * @example
 * fixtureFiles('run-conventional-control').get('runner/runner-journal.jsonl');
 */
export function fixtureFiles(
  base: BaseScenarioId,
  operations: readonly ScenarioOperation[] = [],
): ReadonlyMap<string, Uint8Array> {
  const key = JSON.stringify([base, operations]);
  const cached = built.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const materialized = materializeCase({
    case_id: 'unit',
    ac_ids: [],
    rule_outcomes_reached: [],
    base,
    operations,
    expected: null,
  });
  if (!materialized.ok) {
    throw new Error(`${base} does not build: ${materialized.error.join('; ')}`);
  }
  built.set(key, materialized.value);
  return materialized.value;
}

/**
 * The ingestion input of a trial base's subject trial.
 *
 * @example
 * const input = trialInput('run-conventional-control', [{ op: 'delete_file', path: '$trial/inputs/payment.json' }]);
 */
export function trialInput(
  base: BaseScenarioId = 'run-conventional-control',
  operations: readonly ScenarioOperation[] = [],
): IngestionInput {
  return ingestionInputFromFiles(fixtureFiles(base, operations), subjectDirectoryOf(base));
}

/**
 * The ingestion input of the transport probe: every file is the subject's or execution-level.
 *
 * @example
 * ingest(probeInput()).scope.subject_kind; // 'probe'
 */
export function probeInput(operations: readonly ScenarioOperation[] = []): IngestionInput {
  const files = [...fixtureFiles('probe', operations)].map(([path, bytes]) => ({ path, bytes }));
  const request = { record_type: 'probe_workload_request' } as ProbeWorkloadRequest;
  return { artifacts: files, expected: expectedArtifactsFor(request), execution_scope_artifacts: [] };
}

/**
 * Ingests with the real validator.
 *
 * @example
 * ingest(trialInput()).findings; // []
 */
export function ingest(input: IngestionInput): IngestedEvidence {
  return ingestEvidence(input, VALIDATOR);
}

/**
 * The subject trial's directory of a trial input.
 *
 * @example
 * subjectOf(trialInput()); // 'trials/<trial_id>'
 */
export function subjectOf(input: IngestionInput): string {
  const manifest = input.expected.find((artifact) => artifact.artifact_class === 'trial_manifest');
  return manifest === undefined ? 'probe' : manifest.path.replace(/\/trial-manifest\.json$/u, '');
}

/**
 * The input with one artifact's bytes replaced (or added), or removed when `bytes` is undefined.
 *
 * @example
 * withArtifact(input, 'runner/runner-journal.jsonl', text('{'));
 */
export function withArtifact(input: IngestionInput, path: string, bytes: Uint8Array | undefined): IngestionInput {
  const kept = input.artifacts.filter((artifact) => artifact.path !== path);
  return { ...input, artifacts: bytes === undefined ? kept : [...kept, { path, bytes }] };
}

/**
 * One artifact's bytes from an input.
 *
 * @example
 * artifactBytes(input, 'runner/runner-journal.jsonl');
 */
export function artifactBytes(input: IngestionInput, path: string): Uint8Array {
  const found = [...input.artifacts, ...input.execution_scope_artifacts].find((artifact) => artifact.path === path);
  if (found === undefined) {
    throw new Error(`the input has no ${path}; expected the artifact to exist`);
  }
  return found.bytes;
}

/**
 * The parsed lines (or document) of one artifact.
 *
 * @example
 * artifactValues(input, 'runner/runner-journal.jsonl')[0];
 */
export function artifactValues(input: IngestionInput, path: string): JsonValue[] {
  const text = new TextDecoder().decode(artifactBytes(input, path));
  return path.endsWith('.jsonl')
    ? text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as JsonValue)
    : [JSON.parse(text) as JsonValue];
}

/**
 * UTF-8 bytes of text.
 *
 * @example
 * text('{}');
 */
export function text(content: string): Uint8Array {
  return encoder.encode(content);
}

/**
 * JSONL bytes of values, one per line with a final newline.
 *
 * @example
 * jsonl([{ a: 1 }]);
 */
export function jsonl(values: readonly JsonValue[]): Uint8Array {
  return text(values.map((value) => `${JSON.stringify(value)}\n`).join(''));
}

/**
 * The raw artifact of a JSON document.
 *
 * @example
 * documentArtifact('a.json', { record_type: 'payment' });
 */
export function documentArtifact(path: string, value: JsonValue): RawArtifact {
  return { path, bytes: text(JSON.stringify(value)) };
}
