// Ingested evidence for the treatment-fidelity and probe-verdict units: a golden base built by the
// WP-09 scenario builder in memory (optionally with a subject plan), edited by golden operations,
// and ingested with the real validator, so every unit judges evidence shaped exactly as the
// production ingestion shapes it. Builds are cached per (base, plan, operations).

import { ingestEvidence } from '../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonValue, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { buildTreatmentView } from '../../../../src/treatment-fidelity/treatment-view.ts';
import type { TreatmentView } from '../../../../src/treatment-fidelity/treatment-view.ts';
import { ingestionInputFromFiles } from '../../../golden/evidence-ingestion/ingestion-input.ts';
import {
  GOLDEN_VALIDATOR,
  probeIngestionInput,
} from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { materializeCase } from '../../../support/golden-builder/fixture-materializer.ts';
import type { BaseScenarioId, TrialPlan } from '../../../support/golden-builder/golden-plan.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { subjectDirectoryOf } from '../../../support/golden-builder/scenario-builder.ts';

/** Operation paths of the subject's files (`$trial/` is the probe directory for the probe base). */
export const SUBJECT_FILES = {
  caller: '$trial/journals/caller-journal.jsonl',
  provider: '$trial/journals/provider-journal.jsonl',
  controller: '$trial/journals/controller-journal.jsonl',
  snapshot: '$trial/state/treatment-state-snapshot.json',
  configuration: '$trial/state/provider-trial-configuration.json',
  ledger: '$trial/ledger/ledger-snapshot.json',
  samples: '$trial/settlement/settlement-samples.jsonl',
  runner: 'runner/runner-journal.jsonl',
} as const;

const BASE_PROBE_IDS = {
  attempt: '2abac431-ce69-444b-9e51-255524bba700',
  invocation_event: '0f40e8b4-2aab-47d1-841f-d34cc0eb2f9b',
  dispatch_event: '8d5439d3-ee7c-4eee-8ecd-de54f90cfd9c',
  timeout_event: 'd0a0cf75-0e50-4bf4-b26f-0084786d51cf',
  outcome_event: '49703d4f-e307-4fcf-948f-43cf6539285a',
  signal_event: '058d9892-67a9-4d5f-9d93-80cfd16336ee',
  accepted_event: '8063bc4e-5c6b-4e68-b90c-c6aa90dc981b',
  commit_event: 'dd202349-3dab-4fa4-a817-afe629c0ab78',
  confirmation_event: '2f7ad248-d7d7-4bf8-aca5-3780171c9db6',
  observation_event: '02415fd7-ab76-4cf8-99e2-76d57610ca33',
  release_event: 'b5ba9917-dfca-4dad-86a0-0984660a4386',
  commit: 'd4f19c70-aacf-42fb-bf87-5dbe80d1a6c1',
  transaction: '83edf5ce-1e34-469c-8bf3-0a9fa87ec885',
  call: 'cacf9887-bd96-4e98-868e-5d38dfbf3235',
  /** A well-formed UUIDv4 that no base event uses. */
  absent: '3f2e1d0c-9b8a-4765-a432-10fedcba9876',
} as const;

/** The base probe's identities, as its committed fixture records them. */
export const PROBE_IDS: { readonly [K in keyof typeof BASE_PROBE_IDS]: Uuid4 } = BASE_PROBE_IDS as unknown as {
  readonly [K in keyof typeof BASE_PROBE_IDS]: Uuid4;
};

/** A plan whose single probe attempt ends in a safety release. */
export const SAFETY_RELEASE_PLAN: TrialPlan = {
  deliveries: [{ attempts: [{ behavior: 'safety_release' }] }],
  processing: 'completes',
};
/** A probe invocation whose second attempt is accepted and committed too. */
export const EXTRA_CALL_PLAN: TrialPlan = {
  deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'succeeded' }] }],
  processing: 'completes',
};

const built = new Map<string, IngestedEvidence>();

/**
 * The probe's ingested evidence after `operations`, optionally from a plan.
 *
 * @example
 * probeEvidence([setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/arbiter_winner', 'TRANSPORT')]);
 */
export function probeEvidence(operations: readonly ScenarioOperation[] = [], plan?: TrialPlan): IngestedEvidence {
  return cached(['probe', plan ?? null, operations], () =>
    ingestEvidence(probeIngestionInput(probeFiles(operations, plan)), GOLDEN_VALIDATOR),
  );
}

/**
 * The probe's fixture files after `operations`, as the golden fixtures store them.
 *
 * @example
 * probePackage(probeFiles()); // a stored package over the base probe
 */
export function probeFiles(
  operations: readonly ScenarioOperation[] = [],
  plan?: TrialPlan,
): ReadonlyMap<string, Uint8Array> {
  return materialized('probe', operations, plan);
}

/**
 * The probe's ingested evidence after rewriting the text of one subject file (`$trial/` names
 * the probe directory): the hostile-bytes boundary of Owner amendment A-05. Never cached.
 *
 * @example
 * hostileProbeEvidence(SUBJECT_FILES.caller, (text) => `${text}{"__proto__":1}\n`);
 */
export function hostileProbeEvidence(path: string, rewrite: (text: string) => string): IngestedEvidence {
  const files = new Map(probeFiles());
  const target = path.replace('$trial/', 'probe/');
  const bytes = files.get(target);
  if (bytes === undefined) {
    throw new Error(`${target} is not a probe file; expected one of ${[...files.keys()].join(', ')}`);
  }
  files.set(target, new TextEncoder().encode(rewrite(new TextDecoder().decode(bytes))));
  return ingestEvidence(probeIngestionInput(files), GOLDEN_VALIDATOR);
}

/**
 * The subject trial's ingested evidence of a trial base after `operations`, optionally from a plan.
 *
 * @example
 * trialEvidence('run-conventional-control').scope.trial?.scenario; // 'CONTROL'
 */
export function trialEvidence(
  base: BaseScenarioId,
  operations: readonly ScenarioOperation[] = [],
  plan?: TrialPlan,
): IngestedEvidence {
  return cached([base, plan ?? null, operations], () =>
    ingestEvidence(
      ingestionInputFromFiles(materialized(base, operations, plan), subjectDirectoryOf(base)),
      GOLDEN_VALIDATOR,
    ),
  );
}

/**
 * The treatment view of evidence; throws when it has none, which fails the calling test.
 *
 * @example
 * treatmentView(probeEvidence()).commit?.record.targeted; // true
 */
export function treatmentView(evidence: IngestedEvidence): TreatmentView {
  const view = buildTreatmentView(evidence);
  if (!view.ok) {
    throw new Error(`no treatment view: ${JSON.stringify(view.error)}; expected treatment evidence`);
  }
  return view.value;
}

/**
 * Sets one member of the first record of a type.
 *
 * @example
 * setOp(SUBJECT_FILES.provider, 'provider_commit_confirmed', '/committed_at', '2026-10-05T12:05:08.050Z');
 */
export function setOp(path: string, recordType: string, pointer: string, value: JsonValue): ScenarioOperation {
  return { op: 'set', path, select: { record_type: recordType }, pointer, value };
}

/**
 * Removes the first record of a type from a journal.
 *
 * @example
 * removeOp(SUBJECT_FILES.provider, 'treatment_response_released');
 */
export function removeOp(path: string, recordType: string): ScenarioOperation {
  return { op: 'remove_record', path, select: { record_type: recordType } };
}

/**
 * Sets one member of a single-document file.
 *
 * @example
 * documentOp(SUBJECT_FILES.snapshot, '/consistent_read', false);
 */
export function documentOp(path: string, pointer: string, value: JsonValue): ScenarioOperation {
  return { op: 'set', path, pointer, value };
}

/**
 * Deletes a whole file.
 *
 * @example
 * deleteOp(SUBJECT_FILES.controller);
 */
export function deleteOp(path: string): ScenarioOperation {
  return { op: 'delete_file', path };
}

function materialized(
  base: BaseScenarioId,
  operations: readonly ScenarioOperation[],
  plan?: TrialPlan,
): ReadonlyMap<string, Uint8Array> {
  const result = materializeCase({
    case_id: 'unit',
    ac_ids: [],
    rule_outcomes_reached: [],
    base,
    ...(plan === undefined ? {} : { plan }),
    operations,
    expected: null,
  });
  if (!result.ok) {
    throw new Error(`${base} does not build: ${result.error.join('; ')}`);
  }
  return result.value;
}

function cached(key: readonly unknown[], build: () => IngestedEvidence): IngestedEvidence {
  const text = JSON.stringify(key);
  const hit = built.get(text);
  if (hit !== undefined) {
    return hit;
  }
  const evidence = build();
  built.set(text, evidence);
  return evidence;
}
