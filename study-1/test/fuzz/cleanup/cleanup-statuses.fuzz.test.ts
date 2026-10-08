// Property targets `deriveCleanupStatus`, `deriveLeakAuditStatus` and `foldCleanupActions`
// (BR-RUA-051, AC-RUA-011, design §8.18). Each status function must agree with a reference model
// written from the rule text, and the fold must report, for any action sequence of any number of
// runs, each step's latest step-level status and each resource's latest step-9 action.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { CleanupActionEntry } from '../../../src/cleanup/cleanup-action-fold.ts';
import { foldCleanupActions, stepStatusOf } from '../../../src/cleanup/cleanup-action-fold.ts';
import type { CleanupStepNumber } from '../../../src/cleanup/cleanup-steps.ts';
import { CLEANUP_STEPS, ITEM_ACTIONS, STEP_ACTIONS } from '../../../src/cleanup/cleanup-steps.ts';
import {
  deriveCleanupStatus,
  deriveLeakAuditStatus,
  STABLE_ABSENCE_MS,
} from '../../../src/cleanup/operational-statuses.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { STEP_STATUSES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { AuditPass } from '../../../src/record-contract/records/group-c/leak_audit_result.ts';
import {
  CLEANUP_RESOURCE_ACTIONS,
  LEAK_AUDIT_SURFACES,
} from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const AT = '2026-10-05T12:00:00.000Z' as UtcMillis;

describe('deriveCleanupStatus properties', () => {
  it('is partial on any failed deletion, else succeeded exactly when step 9 succeeded', () => {
    const phase = fc.record({
      step9_status: fc.option(fc.constantFrom(...STEP_STATUSES), { nil: undefined }),
      resources: fc.array(fc.record({ action: fc.constantFrom(...CLEANUP_RESOURCE_ACTIONS) }), { maxLength: 6 }),
    });
    fc.assert(
      fc.property(phase, (input) => {
        const failed = input.resources.some((resource) => resource.action === 'DELETE_FAILED');
        const expected = failed ? 'partial' : input.step9_status === 'succeeded' ? 'succeeded' : 'failed';
        assert.equal(deriveCleanupStatus(input), expected);
      }),
      fuzzParameters(),
    );
  });
});

const pass: fc.Arbitrary<AuditPass> = fc.record({
  started_at: fc.constant(AT),
  completed_at: fc.constant(AT),
  surfaces: fc.array(
    fc.record({
      surface: fc.constantFrom(...LEAK_AUDIT_SURFACES),
      query_ok: fc.boolean(),
      observed: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 2 }),
    }),
    { maxLength: 4 },
  ),
});

describe('deriveLeakAuditStatus properties', () => {
  it('agrees with the BR-RUA-051 reference model', () => {
    const facts = fc.record({
      passes: fc.array(pass, { maxLength: 3 }),
      leak_count: fc.nat(3),
      ambiguous_count: fc.nat(2),
      stable_absence_interval_ms: fc.oneof(fc.nat(2 * STABLE_ABSENCE_MS), fc.constant(STABLE_ABSENCE_MS)),
    });
    fc.assert(
      fc.property(facts, (input) => {
        const surfaces = input.passes.flatMap((audit) => audit.surfaces);
        const conclusive =
          input.passes.length >= 2 && surfaces.every((surface) => surface.query_ok) && input.ambiguous_count === 0;
        const leaked = input.leak_count > 0 || surfaces.some((surface) => surface.observed.length > 0);
        const stable = input.stable_absence_interval_ms >= STABLE_ABSENCE_MS;
        const expected = !conclusive ? 'inconclusive' : leaked ? 'leaks_detected' : stable ? 'clean' : 'inconclusive';
        assert.equal(deriveLeakAuditStatus(input), expected);
      }),
      fuzzParameters(),
    );
  });
});

// Actions of any step, step-level or item-level, including step-9 resource actions on a small
// pool of resources so repeats (re-runs) are common.
const entry: fc.Arbitrary<CleanupActionEntry> = fc
  .record({
    step: fc.constantFrom(...CLEANUP_STEPS),
    step_status: fc.constantFrom(...STEP_STATUSES),
    kind: fc.constantFrom('step', 'resource', 'item'),
    resource_action: fc.constantFrom(...CLEANUP_RESOURCE_ACTIONS),
    item_action: fc.constantFrom(...Object.values(ITEM_ACTIONS)),
    identifier: fc.constantFrom('r1', 'r2', 'r3'),
    minute: fc.nat(59),
  })
  .map(({ step, step_status, kind, resource_action, item_action, identifier, minute }) => {
    const base = { step, step_status, cleanup_mode: 'NORMAL' as const, cleanup_induced: false, reasons: [] };
    const occurred_at = `2026-10-05T12:${String(minute).padStart(2, '0')}:00.000Z` as UtcMillis;
    if (kind === 'step') {
      return { body: { ...base, action: STEP_ACTIONS[step] }, occurred_at };
    }
    if (kind === 'item') {
      return {
        body: { ...base, action: item_action, resource_type: 'AWS::Lambda::Function', resource_identifier: identifier },
        occurred_at,
      };
    }
    return {
      body: {
        ...base,
        step: 9,
        action: resource_action,
        resource_type: 'AWS::DynamoDB::Table',
        resource_identifier: identifier,
        ownership_basis: 'resource_manifest_and_tags' as const,
      },
      occurred_at,
    };
  });

function latestStepStatus(entries: readonly CleanupActionEntry[], step: CleanupStepNumber): string | undefined {
  return entries.filter((each) => each.body.step === step && each.body.action === STEP_ACTIONS[step]).at(-1)?.body
    .step_status;
}

describe('foldCleanupActions properties', () => {
  it('reports the latest step-level status per step and the latest action per resource', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), (entries) => {
        const fold = foldCleanupActions(entries);
        for (const step of CLEANUP_STEPS) {
          assert.equal(stepStatusOf(fold, step), latestStepStatus(entries, step));
          assert.equal(fold.succeeded_steps.has(step), latestStepStatus(entries, step) === 'succeeded');
        }
        const identifiers = fold.resources.map((resource) => resource.resource_identifier);
        assert.equal(new Set(identifiers).size, identifiers.length);
        for (const resource of fold.resources) {
          const latest = entries
            .filter(
              (each) =>
                each.body.step === 9 &&
                each.body.resource_identifier === resource.resource_identifier &&
                each.body.ownership_basis !== undefined,
            )
            .at(-1);
          assert.equal(resource.action, latest?.body.action);
        }
        const deleted = fold.deleted_dlq_message_ids;
        assert.deepEqual(deleted, [...new Set(deleted)].sort());
      }),
      fuzzParameters(),
    );
  });
});
