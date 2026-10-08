// The tables one admitted execution's store adapter is bound to (design §9.3, §9.7; BR-RUA-045):
// the five run-owned tables by the deterministic stack names, keyed by the store's snake-case
// roles, and the coordination table the frozen environment admitted.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executionTables } from '../../../src/operator-cli/execution-tables.ts';
import { goldenAdmitted } from './support/golden-admitted.ts';

describe('executionTables', () => {
  it('names every run-owned table of the execution and the admitted coordination table', () => {
    assert.deepEqual(executionTables(goldenAdmitted('run')), {
      ok: true,
      value: {
        ledger: 'suc1-b42ee7a8-ledger',
        experiment_journal: 'suc1-b42ee7a8-experiment-journal',
        caller_journal: 'suc1-b42ee7a8-caller-journal',
        control: 'suc1-b42ee7a8-control',
        trial_registry: 'suc1-b42ee7a8-trial-registry',
        coordination: 'suc-study-1-coordination',
      },
    });
    const probe = executionTables(goldenAdmitted('probe'));
    assert.equal(probe.ok && probe.value.ledger, 'suc1-2559d5f6-ledger');
  });

  it('refuses a frozen coordination ARN that names no table, under the lease rule', () => {
    const admitted = goldenAdmitted('run');
    const unnamed = {
      ...admitted,
      manifest: {
        ...admitted.manifest,
        environment: {
          ...admitted.manifest.environment,
          coordination_table_arn: 'arn:aws:dynamodb:us-east-1:012345678901:table/',
        },
      },
    };
    assert.deepEqual(executionTables(unnamed), {
      ok: false,
      error: {
        code: 'COORDINATION_TABLE_UNNAMED',
        subject: 'BR-RUA-045',
        detail:
          'coordination_table_arn "arn:aws:dynamodb:us-east-1:012345678901:table/" names no table; expected arn:aws:dynamodb:<region>:<account>:table/<name>',
      },
    });
  });
});
