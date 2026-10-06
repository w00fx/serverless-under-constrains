// AC-RUA-014 — Invalid Inputs Are Rejected Before Execution (BR-RUA-017, BR-RUA-039..042,
// BR-RUA-045, BR-RUA-046, BR-RUA-028; design §10.1, §14 row 014).
// Given an execution request, when its financial input, identity input, source provenance,
// account, Region, safety limits, qualification or coordination configuration is invalid, then
// admission rejects it before any trial or cloud mutation: the attempt keeps a structured
// `admission_rejection` and its preflight journal, and no manifest, trial, result or package
// index exists.
//
// Boundary (spec Verification: integration): the production `admitExecution` over every named
// admission fake, the real synthesizer and scope recomputation, the memory evidence file system
// and the shared `RecordingMutationLog`, which every fake cloud write would land in.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { leaseOwnerOf } from '../../../src/coordination-lease/lease-store-port.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonValue, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { FOREIGN_ACCOUNT_ID } from '../../support/admission/admission-fixtures.ts';
import { financialRecords } from '../../support/admission/admission-fixtures.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';
import { FakeAccountSettings } from '../../support/admission/fake-account-settings.ts';
import { FakeCallerIdentity } from '../../support/admission/fake-caller-identity.ts';
import { FakeCoordinationTable } from '../../support/admission/fake-coordination-table.ts';
import { synthesizedAssemblyFiles } from '../../support/admission/synth-templates.ts';
import type { ScriptedAssemblyFile } from '../../support/deployment-assembly/fake-command-runner.ts';

const HOLDER = leaseOwnerOf(
  { execution_kind: 'RUN', run_id: '7d2c4b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d' as Uuid4 },
  'ab'.repeat(32) as Sha256Hex,
);

interface ExpectedRejection {
  readonly rejection_class: string;
  readonly failed_check_id: string;
  readonly codes: readonly string[];
  /** A12 rejects after its one local synthesis; every earlier check rejects before any. */
  readonly synthesized?: true;
}

// The rejection, the journal and the absence of every package file and cloud mutation.
async function assertRejectedBeforeExecution(
  harness: AdmissionHarness,
  outcome: AdmissionOutcome,
  expected: ExpectedRejection,
): Promise<void> {
  assert.equal(outcome.kind, 'rejected', JSON.stringify(outcome));
  assert.deepEqual(
    outcome.reasons.map((reason) => reason.code),
    expected.codes,
  );
  const rejection = await harness.rejection(outcome.admission_attempt_id);
  assert.ok(rejection !== undefined && isJsonObject(rejection), 'the admission_rejection is stored');
  assert.equal(harness.validator.validateAs('admission_rejection', rejection).valid, true);
  assert.equal(rejection['rejection_class'], expected.rejection_class);
  assert.equal(rejection['failed_check_id'], expected.failed_check_id);
  assert.equal(rejection['execution_kind'], harness.kind);
  assert.deepEqual(rejection['reasons'], outcome.reasons as unknown as JsonValue);
  const journal = harness.journalRecords(outcome.admission_attempt_id);
  const checks = journal.map((record) => (isJsonObject(record) ? record['check_id'] : undefined));
  const failedAt = Number(expected.failed_check_id.slice(1));
  assert.deepEqual(
    checks,
    Array.from({ length: failedAt }, (_, index) => `A${String(index + 1)}`),
  );
  for (const record of journal) {
    assert.equal(harness.validator.validateAs('preflight_check_recorded', record).valid, true);
  }
  const last = journal.at(-1);
  assert.ok(last !== undefined && isJsonObject(last));
  assert.equal(last['result'], 'failed');
  assert.equal(last['rejection_class'], expected.rejection_class);
  assert.equal(harness.journalFinalized(outcome.admission_attempt_id), true);
  assert.deepEqual(await harness.packagePaths(), [], 'no manifest, trial, result or index is written');
  assert.deepEqual(harness.mutationLog.entries(), [], 'no cloud mutation');
  assert.deepEqual(
    harness.runner.invocations().map((invocation) => invocation.args[1]),
    expected.synthesized === true ? ['synth'] : [],
    'nothing is synthesized before A12, and nothing is ever deployed',
  );
}

describe('AC-RUA-014 invalid inputs are rejected before execution', () => {
  describe('financial-input', () => {
    it('financial-input-unequal-amounts', async () => {
      const harness = await AdmissionHarness.create('RUN');
      harness.request = { ...harness.request, financial_inputs: financialRecords({}, { approved_amount_minor: 9000 }) };
      await assertRejectedBeforeExecution(harness, await harness.admit(), {
        rejection_class: 'FINANCIAL_INPUT',
        failed_check_id: 'A3',
        codes: ['AMOUNTS_UNEQUAL'],
      });
    });

    it('financial-input-zero-amount', async () => {
      const harness = await AdmissionHarness.create('RUN');
      harness.request = {
        ...harness.request,
        financial_inputs: financialRecords({ captured_amount_minor: 0 }, { approved_amount_minor: 0 }),
      };
      await assertRejectedBeforeExecution(harness, await harness.admit(), {
        rejection_class: 'FINANCIAL_INPUT',
        failed_check_id: 'A3',
        codes: ['AMOUNT_NOT_POSITIVE_INTEGER', 'AMOUNT_NOT_POSITIVE_INTEGER'],
      });
    });

    it('financial-input-unsafe-amount', async () => {
      const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
      const unsafe = Number.MAX_SAFE_INTEGER + 1;
      harness.request = {
        ...harness.request,
        financial_inputs: financialRecords({ captured_amount_minor: unsafe }, { approved_amount_minor: unsafe }),
      };
      await assertRejectedBeforeExecution(harness, await harness.admit(), {
        rejection_class: 'FINANCIAL_INPUT',
        failed_check_id: 'A3',
        codes: ['AMOUNT_UNSAFE', 'AMOUNT_UNSAFE'],
      });
    });

    it('financial-input-non-brl-currency', async () => {
      const harness = await AdmissionHarness.create('VARIANT_VALIDATION');
      harness.request = {
        ...harness.request,
        financial_inputs: financialRecords({ currency: 'USD' }, { currency: 'USD' }),
      };
      await assertRejectedBeforeExecution(harness, await harness.admit(), {
        rejection_class: 'FINANCIAL_INPUT',
        failed_check_id: 'A3',
        codes: ['CURRENCY_NOT_BRL', 'CURRENCY_NOT_BRL'],
      });
    });
  });

  it('identity', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.request = {
      ...harness.request,
      financial_inputs: financialRecords({ payment_id: ' \t ' }, { payment_id: ' \t ', refund_request_id: '' }),
    };
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'IDENTITY',
      failed_check_id: 'A4',
      codes: ['IDENTIFIER_EMPTY', 'IDENTIFIER_EMPTY', 'IDENTIFIER_EMPTY'],
    });
  });

  it('source-provenance', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.git.addUntracked('study-1/notes.txt');
    harness.git.modifyLockfile();
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'SOURCE_PROVENANCE',
      failed_check_id: 'A5',
      codes: ['UNTRACKED_FILE', 'LOCKFILE_MODIFIED'],
    });
  });

  it('account', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.sts = new FakeCallerIdentity({ account: FOREIGN_ACCOUNT_ID });
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'ACCOUNT',
      failed_check_id: 'A7',
      codes: ['ACCOUNT_NOT_ALLOWLISTED'],
    });
  });

  it('region', async () => {
    const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
    harness.sts = new FakeCallerIdentity({ region: 'sa-east-1' });
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'REGION',
      failed_check_id: 'A7',
      codes: ['REGION_NOT_ALLOWED'],
    });
  });

  it('safety', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.lambdaAccount = new FakeAccountSettings(3);
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'SAFETY',
      failed_check_id: 'A6',
      codes: ['UNRESERVED_CONCURRENCY_LOW'],
    });
  });

  it('safety-conflicting-lease', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.lease.takeOverBy(HOLDER, '2026-10-01T00:00:00.000Z' as UtcMillis, 3);
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'SAFETY',
      failed_check_id: 'A8',
      codes: ['CONFLICTING_LEASE'],
    });
  });

  it('safety-missing-ownership-strategy', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.synthScript = (context): readonly ScriptedAssemblyFile[] =>
      synthesizedAssemblyFiles(context, { stack_tags: 'absent' });
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'SAFETY',
      failed_check_id: 'A12',
      codes: ['OWNERSHIP_STRATEGY_MISSING'],
      synthesized: true,
    });
  });

  it('qualification', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.request = {
      ...harness.request,
      qualification: { ...harness.selection(), original_package_index_sha256: 'cd'.repeat(32) as Sha256Hex },
    };
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'QUALIFICATION',
      failed_check_id: 'A10',
      codes: ['SELECTION_MISMATCH'],
    });
  });

  it('coordination-configuration', async () => {
    const harness = await AdmissionHarness.create('VARIANT_VALIDATION');
    harness.coordination = new FakeCoordinationTable({ time_to_live_status: 'ENABLED' });
    await assertRejectedBeforeExecution(harness, await harness.admit(), {
      rejection_class: 'COORDINATION_CONFIGURATION',
      failed_check_id: 'A8',
      codes: ['COORDINATION_TABLE_INVALID'],
    });
  });
});
