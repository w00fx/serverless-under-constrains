// Where one simulated trial (or the probe) lives: its execution, identities, partition, evidence
// directory and slot on the golden timeline. Every trial gets a 900 s slot, longer than the 600 s
// observation deadline plus collection, so trials never overlap (BR-RUA-019 runs them one at a
// time) and the runner journal stays in time order.

import type { ExecutionIdentityFields } from '../../../src/record-contract/envelope.ts';
import type { Scenario, Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { linkSha256 } from './digest-links.ts';
import type { PlanCaller } from './golden-plan.ts';

/** Offsets inside a trial slot, in milliseconds after the slot start. */
export const SLOT_OFFSETS = {
  trial_manifest_frozen: 0,
  partitions_verified_absent: 500,
  configuration_written: 1000,
  treatment_armed: 2000,
  registration_written: 3000,
  published: 5000,
} as const;

/** The first trial slot starts 300 s after the execution manifest is frozen. */
export const FIRST_SLOT_MS = 300_000;
export const SLOT_LENGTH_MS = 900_000;

/** The execution-level paths every base holds. */
export const EXECUTION_MANIFEST_PATH = 'admission/execution-manifest.json';
export const RESOURCE_MANIFEST_PATH = 'provisioning/resource-manifest.json';
export const RUNNER_JOURNAL_PATH = 'runner/runner-journal.jsonl';

/** The execution a trial belongs to. */
export interface ExecutionContext {
  /** Label prefix of every derived id of the execution. */
  readonly label: string;
  readonly execution_id: Uuid4;
  readonly identity: ExecutionIdentityFields;
  /** First eight hex digits of the execution id: the `<p>` of every resource name (design §9.7). */
  readonly resource_prefix: string;
}

/** One trial of an execution, or the probe's single workload. */
export interface TrialContext {
  readonly execution: ExecutionContext;
  readonly label: string;
  readonly caller: PlanCaller;
  readonly scenario: Scenario;
  /** Absent for the probe, which has no trial (D-06). */
  readonly trial?: { readonly trial_id: Uuid4; readonly trial_manifest_sha256: Sha256Hex };
  readonly partition_key: string;
  /** `trials/<trial_id>` or `probe`. */
  readonly directory: string;
  readonly slot_ms: number;
}

/**
 * The start of the slot of the trial at `sequence` (1-based; the probe uses sequence 1).
 *
 * @example
 * slotStartMs(2); // 1_200_000
 */
export function slotStartMs(sequence: number): number {
  return FIRST_SLOT_MS + (sequence - 1) * SLOT_LENGTH_MS;
}

/**
 * The publication (or probe invocation) instant of a trial: every attempt and sample is timed
 * from it.
 *
 * @example
 * publishedMs(context); // context.slot_ms + 5000
 */
export function publishedMs(context: TrialContext): number {
  return context.slot_ms + SLOT_OFFSETS.published;
}

/**
 * The trial-scoped path of a file inside the trial directory.
 *
 * @example
 * trialPath(context, 'ledger/ledger-snapshot.json'); // 'trials/<id>/ledger/ledger-snapshot.json'
 */
export function trialPath(context: TrialContext, relative: string): string {
  return `${context.directory}/${relative}`;
}

/**
 * The correlation every execution-level record carries: the execution identity and the frozen
 * execution-manifest digest.
 *
 * @example
 * executionCorrelation(execution); // { run_id, execution_manifest_sha256: '@sha256(...)' }
 */
export function executionCorrelation(execution: ExecutionContext): Readonly<Record<string, string>> {
  return { ...execution.identity, execution_manifest_sha256: linkSha256(EXECUTION_MANIFEST_PATH) };
}

/**
 * The correlation of a trial-scoped record: the execution correlation plus the trial pair, which
 * the probe does not have.
 *
 * @example
 * trialCorrelation(context); // { run_id, execution_manifest_sha256, trial_id, trial_manifest_sha256 }
 */
export function trialCorrelation(context: TrialContext): Readonly<Record<string, string>> {
  return { ...executionCorrelation(context.execution), ...(context.trial ?? {}) };
}

/**
 * The resource name of a variant queue (design §9.7).
 *
 * @example
 * queueName(execution, 'conventional', 'source'); // 'suc1-<p>-conventional-source.fifo'
 */
export function queueName(execution: ExecutionContext, variant: string, role: 'source' | 'dlq'): string {
  return `suc1-${execution.resource_prefix}-${variant}-${role}.fifo`;
}
