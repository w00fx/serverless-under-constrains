// The cleanup journal is the one account of what cleanup did (BR-RUA-048 step 6 "records
// cleanup-induced transitions separately"; AC-RUA-011 "cleanup runs one or more times"). Every
// run appends its actions; the frozen `cleanup_result` is a fold over the actions of every run,
// so a re-run that skips a succeeded step still reports what that step did.
//
// Fold rules:
// - a step's status is its latest step-level action; a terminal status takes its start time
//   from the latest `started` action before it;
// - a resource's entry is its latest step-9 action (an `ALREADY_ABSENT` on a re-run replaces an
//   earlier `DELETE_FAILED`: the resource is gone either way);
// - stopped durable executions, applied safety releases and DLQ messages are the identifiers of
//   their item actions, unique and sorted.

import type { EventBody } from '../event-journal/journal-event.ts';
import type { UtcMillis } from '../record-contract/primitives.ts';
import type { StepStatus } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResource, CleanupStep } from '../record-contract/records/group-c/cleanup_result.ts';
import type { CleanupResourceAction } from '../record-contract/records/group-c/vocabulary.ts';
import { CLEANUP_RESOURCE_ACTIONS } from '../record-contract/records/group-c/vocabulary.ts';
import type { CleanupStepNumber } from './cleanup-steps.ts';
import { CLEANUP_STEPS, ITEM_ACTIONS, STEP_ACTIONS } from './cleanup-steps.ts';
import { resourceKey } from './resource-names.ts';

/** The record-specific fields of one `cleanup_action_recorded` event. */
export type CleanupActionBody = EventBody<'cleanup_action_recorded'>;

/** One recorded cleanup action and when it happened. */
export interface CleanupActionEntry {
  readonly body: CleanupActionBody;
  readonly occurred_at: UtcMillis;
}

export interface CleanupFold {
  /** One entry per step that has a step-level action, in step-number order. */
  readonly steps: readonly CleanupStep[];
  readonly succeeded_steps: ReadonlySet<number>;
  readonly resources: readonly CleanupResource[];
  /** Treatment partitions whose safety release cleanup applied (step 5). */
  readonly applied_releases: readonly string[];
  /** Durable executions cleanup stopped (step 5). */
  readonly stopped_durable_execution_arns: readonly string[];
  /** Treatment partitions already recorded as cleanup-induced safety releases (step 6). */
  readonly recorded_safety_releases: ReadonlySet<string>;
  /** Durable executions already recorded as cleanup-induced stops (step 6). */
  readonly recorded_execution_stops: ReadonlySet<string>;
  readonly captured_dlq_message_ids: readonly string[];
  readonly deleted_dlq_message_ids: readonly string[];
  /** Captured messages step 8 found already gone. */
  readonly absent_dlq_message_ids: readonly string[];
}

const DELETION_STEP = 9;

/**
 * Folds recorded cleanup actions, oldest first, into what the cleanup result reports.
 *
 * @example
 * const fold = foldCleanupActions([...history.entries, ...journal.entries()]);
 * fold.succeeded_steps.has(9); // true once the deletion step succeeded in any run
 */
export function foldCleanupActions(entries: readonly CleanupActionEntry[]): CleanupFold {
  const steps = CLEANUP_STEPS.flatMap((step) => foldStep(step, entries));
  return {
    steps,
    succeeded_steps: new Set(steps.filter((step) => step.status === 'succeeded').map((step) => step.step)),
    resources: foldResources(entries),
    applied_releases: identifiersOf(entries, ITEM_ACTIONS.safetyReleaseApplied),
    stopped_durable_execution_arns: identifiersOf(entries, ITEM_ACTIONS.durableStopApplied),
    recorded_safety_releases: new Set(identifiersOf(entries, ITEM_ACTIONS.treatmentSafetyReleased)),
    recorded_execution_stops: new Set(identifiersOf(entries, ITEM_ACTIONS.durableExecutionStopped)),
    captured_dlq_message_ids: identifiersOf(entries, ITEM_ACTIONS.dlqMessageCaptured),
    deleted_dlq_message_ids: identifiersOf(entries, ITEM_ACTIONS.dlqMessageDeleted),
    absent_dlq_message_ids: identifiersOf(entries, ITEM_ACTIONS.dlqMessageAbsent),
  };
}

/**
 * The folded status of one step, or undefined when the step has no step-level action.
 *
 * @example
 * stepStatusOf(fold, 9); // 'succeeded'
 */
export function stepStatusOf(fold: CleanupFold, step: CleanupStepNumber): StepStatus | undefined {
  return fold.steps.find((entry) => entry.step === step)?.status;
}

function foldStep(step: CleanupStepNumber, entries: readonly CleanupActionEntry[]): CleanupStep[] {
  const own = entries.filter((entry) => entry.body.step === step && entry.body.action === STEP_ACTIONS[step]);
  const latest = own.at(-1);
  if (latest === undefined) {
    return [];
  }
  const status = latest.body.step_status;
  if (status === 'started') {
    return [{ step, status, started_at: latest.occurred_at, reasons: [] }];
  }
  const start = own.findLast((entry) => entry.body.step_status === 'started');
  return [
    {
      step,
      status,
      ...(start === undefined ? {} : { started_at: start.occurred_at }),
      completed_at: latest.occurred_at,
      reasons: latest.body.reasons,
    },
  ];
}

function foldResources(entries: readonly CleanupActionEntry[]): CleanupResource[] {
  const latest = new Map<string, CleanupResource>();
  for (const { body } of entries) {
    const resource = resourceEntryOf(body);
    if (resource !== undefined) {
      latest.set(
        resourceKey({ resource_type: resource.resource_type, identifier: resource.resource_identifier }),
        resource,
      );
    }
  }
  return [...latest.values()];
}

function resourceEntryOf(body: CleanupActionBody): CleanupResource | undefined {
  const { resource_type: type, resource_identifier: identifier, ownership_basis: basis, action } = body;
  if (body.step !== DELETION_STEP || !isResourceAction(action)) {
    return undefined;
  }
  if (type === undefined || identifier === undefined || basis === undefined) {
    return undefined;
  }
  return {
    resource_type: type,
    resource_identifier: identifier,
    ownership_basis: basis,
    action,
    reasons: body.reasons,
  };
}

/**
 * Whether a journal action names what step 9 did with one resource.
 *
 * @example
 * isResourceAction('ALREADY_ABSENT'); // true
 * isResourceAction('CONSUMER_DISABLED'); // false
 */
export function isResourceAction(action: string): action is CleanupResourceAction {
  return (CLEANUP_RESOURCE_ACTIONS as readonly string[]).includes(action);
}

function identifiersOf(entries: readonly CleanupActionEntry[], action: string): string[] {
  const identifiers = entries.flatMap(({ body }) =>
    body.action === action && body.resource_identifier !== undefined ? [body.resource_identifier] : [],
  );
  return [...new Set(identifiers)].sort();
}
