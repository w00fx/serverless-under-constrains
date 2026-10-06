// The trial builds several oracle suites share: the bases, a conventional treatment whose retry
// ends in the DLQ, and a CONTROL trial whose processing is still active at the deadline.

import type { TrialBuild } from './built-trials.ts';

export const CONVENTIONAL_CONTROL: TrialBuild = { base: 'run-conventional-control' };
export const CONVENTIONAL_TREATMENT: TrialBuild = { base: 'run-conventional-treatment' };
export const DURABLE_CONTROL: TrialBuild = { base: 'run-durable-control' };
export const DURABLE_TREATMENT: TrialBuild = { base: 'run-durable-treatment' };

/** A targeted commit and timeout, then a redelivery whose commit fails: the message reaches the DLQ. */
export const DLQ_TREATMENT: TrialBuild = {
  base: 'run-conventional-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'commit_failed' }] }],
    processing: 'completes',
  },
};

/** A CONTROL commit that fails and is never redelivered before the deadline. */
export const ACTIVE_CONTROL: TrialBuild = {
  base: 'run-conventional-control',
  plan: { deliveries: [{ attempts: [{ behavior: 'commit_failed' }] }], processing: 'active_at_deadline' },
};

/**
 * A build with more operations.
 *
 * @example
 * edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/inputs/payment.json' }]);
 */
export function edited(build: TrialBuild, operations: NonNullable<TrialBuild['operations']>): TrialBuild {
  return { ...build, operations: [...(build.operations ?? []), ...operations] };
}
