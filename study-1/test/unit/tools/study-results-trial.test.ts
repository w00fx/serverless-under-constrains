// One trial of the derived Study 1 results (close-out Phase 1): the verdict from the oracle, the
// money from the ledger, the retry path from the caller journal and the Durable history, and a
// stop whenever two sources disagree.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { EvidencePackage } from '../../../tools/lib/study-results-reading.ts';
import { loadPackage, objectsOf, readRecord } from '../../../tools/lib/study-results-reading.ts';
import type { TrialResult } from '../../../tools/lib/study-results-trial.ts';
import { commitGapSeconds, deriveTrialResult, retryMechanismOf } from '../../../tools/lib/study-results-trial.ts';
import type { EditableRecord, FileMap, TrialFixture } from './support/in-memory-evidence.ts';
import {
  CONTROL_CONVENTIONAL,
  digestOf,
  editableIn,
  executionFiles,
  firstOf,
  InMemoryEvidence,
  RUN_ID,
  TIMEOUT_DURABLE,
} from './support/in-memory-evidence.ts';

const DIRECTORY = `runs/${RUN_ID}`;

function packageOf(trial: TrialFixture, editTrials?: (files: FileMap) => void): EvidencePackage {
  const evidence = new InMemoryEvidence();
  evidence.putPackage(DIRECTORY, executionFiles('run', RUN_ID, [trial], editTrials));
  return loadPackage(DIRECTORY, evidence.read);
}

function firstSummaryEntry(pkg: EvidencePackage): JsonObject {
  const [entry] = objectsOf(readRecord(pkg, 'summary/run-summary.json').record, 'trial_results', 'fixture summary');
  assert.ok(entry);
  return entry;
}

function derive(trial: TrialFixture, editTrials?: (files: FileMap) => void): TrialResult {
  const pkg = packageOf(trial, editTrials);
  return deriveTrialResult(pkg, firstSummaryEntry(pkg));
}

function edit(trial: TrialFixture, file: string, change: (record: EditableRecord) => void): (files: FileMap) => void {
  return (files) => {
    const path = `trials/${trial.id}/${file}`;
    const record = editableIn(files, path);
    change(record);
    files.set(path, record);
  };
}

const conventionalDirectory = `${DIRECTORY}/trials/${CONTROL_CONVENTIONAL.id}`;
const durableDirectory = `${DIRECTORY}/trials/${TIMEOUT_DURABLE.id}`;

describe('deriveTrialResult', () => {
  it('derives a conventional CONTROL trial: one refund, no retry, no Durable execution', () => {
    const pkg = packageOf(CONTROL_CONVENTIONAL);
    const result = derive(CONTROL_CONVENTIONAL);
    assert.deepEqual(
      { ...result, evidence_refs: result.evidence_refs.map((ref) => ref.artifact_path) },
      {
        trial_id: CONTROL_CONVENTIONAL.id,
        sequence: 1,
        scenario: 'CONTROL',
        variant_id: 'conventional',
        preservation_verdict: 'pass',
        correct_completion: true,
        trial_validity: 'valid',
        treatment_fidelity: 'faithful',
        successful_transaction_count: 1,
        refunded_total_minor: '10000',
        currency: 'BRL',
        commit_times: ['2026-10-07T06:00:00.000Z'],
        commit_gap_seconds: null,
        retry: { mechanism: 'none', source_receive_count: 1, durable_step_attempt: null, durable_executions: [] },
        evidence_refs: [
          `trials/${CONTROL_CONVENTIONAL.id}/derived/oracle-result.json`,
          `trials/${CONTROL_CONVENTIONAL.id}/journals/caller-journal.jsonl`,
          `trials/${CONTROL_CONVENTIONAL.id}/ledger/ledger-snapshot.json`,
          `trials/${CONTROL_CONVENTIONAL.id}/trial-manifest.json`,
        ],
      },
    );
    assert.deepEqual(result.evidence_refs[0], {
      package_index_sha256: pkg.index_sha256,
      artifact_path: `trials/${CONTROL_CONVENTIONAL.id}/derived/oracle-result.json`,
      artifact_sha256: pkg.files.get(`trials/${CONTROL_CONVENTIONAL.id}/derived/oracle-result.json`)?.sha256,
    });
  });

  it('derives a Durable COMMIT_THEN_TIMEOUT trial: two refunds, sorted commits, a step retry', () => {
    const result = derive(TIMEOUT_DURABLE);
    assert.equal(result.successful_transaction_count, 2);
    assert.equal(result.refunded_total_minor, '20000');
    assert.deepEqual(result.commit_times, ['2026-10-07T06:00:00.000Z', '2026-10-07T06:01:04.095Z']);
    assert.equal(result.commit_gap_seconds, 64.095);
    assert.deepEqual(result.retry, {
      mechanism: 'durable_step_retry',
      source_receive_count: 1,
      durable_step_attempt: 2,
      durable_executions: [{ status: 'SUCCEEDED', final_history_event: 'ExecutionSucceeded', highest_step_attempt: 2 }],
    });
    assert.deepEqual(
      result.evidence_refs.map((ref) => ref.artifact_path.split('/').slice(2).join('/')),
      [
        'derived/oracle-result.json',
        'execution-metadata/durable-executions.json',
        'journals/caller-journal.jsonl',
        'ledger/ledger-snapshot.json',
        'trial-manifest.json',
      ],
    );
  });

  it('counts no money and no gap when the ledger holds no successful transaction', () => {
    const none = { ...CONTROL_CONVENTIONAL, commits: [] };
    const result = derive(none);
    assert.equal(result.successful_transaction_count, 0);
    assert.equal(result.refunded_total_minor, '0');
    assert.equal(result.currency, null);
    assert.equal(result.commit_gap_seconds, null);
  });

  it('refuses a summary that cites other oracle bytes than the package holds', () => {
    const pkg = packageOf(CONTROL_CONVENTIONAL);
    const forged = { ...firstSummaryEntry(pkg), oracle_result_ref: { artifact_sha256: digestOf('other') } };
    assert.throws(() => deriveTrialResult(pkg, forged), {
      message: `${conventionalDirectory}: the summary cites oracle result ${digestOf('other')}; expected the indexed ${pkg.files.get(`trials/${CONTROL_CONVENTIONAL.id}/derived/oracle-result.json`)?.sha256 ?? ''}`,
    });
  });

  it('refuses an incomplete ledger and successful transactions in two currencies', () => {
    const ledger = 'ledger/ledger-snapshot.json';
    assert.throws(
      () =>
        derive(
          CONTROL_CONVENTIONAL,
          edit(CONTROL_CONVENTIONAL, ledger, (record) => (record['complete'] = false)),
        ),
      {
        message: `${conventionalDirectory}/${ledger}: complete is false; expected a complete ledger snapshot`,
      },
    );
    const twoCurrencies = edit(TIMEOUT_DURABLE, ledger, (record) => {
      firstOf(record, 'transactions')['currency'] = 'USD';
    });
    assert.throws(() => derive(TIMEOUT_DURABLE, twoCurrencies), {
      message: `${durableDirectory}/${ledger}: successful transactions are in USD, BRL; expected one currency`,
    });
    const badTime = edit(CONTROL_CONVENTIONAL, ledger, (record) => {
      firstOf(record, 'transactions')['commit_requested_at'] = '2026-10-07';
    });
    assert.throws(() => derive(CONTROL_CONVENTIONAL, badTime), {
      message: `${conventionalDirectory}/${ledger}: commit_requested_at is "2026-10-07"; expected a UTC millisecond timestamp`,
    });
  });

  it('refuses an oracle whose monetary observations differ from the ledger in count or total', () => {
    const oracle = 'derived/oracle-result.json';
    const observing = (count: number, total: string): ((files: FileMap) => void) =>
      edit(CONTROL_CONVENTIONAL, oracle, (record) => {
        record['monetary_observations'] = { successful_transaction_count: count, refunded_total_minor: total };
      });
    for (const [count, total] of [
      [2, '10000'],
      [1, '20000'],
    ] as const) {
      assert.throws(() => derive(CONTROL_CONVENTIONAL, observing(count, total)), {
        message: `${conventionalDirectory}/${oracle}: the oracle observed ${String(count)} transaction(s) totalling ${total}; expected the ledger's 1 totalling 10000`,
      });
    }
  });

  it('refuses a durable trial without its Durable history, or with an incomplete one', () => {
    const metadata = 'execution-metadata/durable-executions.json';
    const dropped = (files: FileMap): void => {
      files.delete(`trials/${TIMEOUT_DURABLE.id}/${metadata}`);
    };
    assert.throws(() => derive(TIMEOUT_DURABLE, dropped), {
      message: `${durableDirectory}/${metadata} is absent; expected the Durable execution history of a durable trial`,
    });
    assert.throws(
      () =>
        derive(
          TIMEOUT_DURABLE,
          edit(TIMEOUT_DURABLE, metadata, (record) => (record['list_complete'] = false)),
        ),
      {
        message: `${durableDirectory}/${metadata}: list_complete is false; expected a complete Durable execution listing`,
      },
    );
    const execution = (change: (one: EditableRecord) => void): ((files: FileMap) => void) =>
      edit(TIMEOUT_DURABLE, metadata, (record) => {
        change(firstOf(record, 'executions'));
      });
    assert.throws(
      () =>
        derive(
          TIMEOUT_DURABLE,
          execution((one) => (one['history_complete'] = false)),
        ),
      {
        message: `${durableDirectory}/${metadata}: history_complete is false; expected a complete Durable execution history`,
      },
    );
    assert.throws(
      () =>
        derive(
          TIMEOUT_DURABLE,
          execution((one) => (one['history'] = [])),
        ),
      {
        message: `${durableDirectory}/${metadata}: history is empty; expected at least one history event`,
      },
    );
  });

  it('refuses a caller journal without an invocation, or one whose step attempt the history contradicts', () => {
    const journal = 'journals/caller-journal.jsonl';
    const noInvocation = (files: FileMap): void => {
      files.set(`trials/${CONTROL_CONVENTIONAL.id}/${journal}`, '{"record_type":"caller_invocation_completed"}');
    };
    assert.throws(() => derive(CONTROL_CONVENTIONAL, noInvocation), {
      message: `${conventionalDirectory}/${journal} holds no caller_invocation_started; expected at least one caller invocation`,
    });
    const oneAttempt = (files: FileMap): void => {
      files.set(
        `trials/${TIMEOUT_DURABLE.id}/${journal}`,
        '{"record_type":"caller_invocation_started","approximate_receive_count":1,"step_attempt":1}',
      );
    };
    assert.throws(() => derive(TIMEOUT_DURABLE, oneAttempt), {
      message: `${durableDirectory}/${journal}: the caller journal reaches step attempt 1; expected the Durable history's 2`,
    });
    const noAttempt = (files: FileMap): void => {
      files.set(
        `trials/${TIMEOUT_DURABLE.id}/${journal}`,
        '{"record_type":"caller_invocation_started","approximate_receive_count":1}',
      );
    };
    assert.throws(() => derive(TIMEOUT_DURABLE, noAttempt), {
      message: `${durableDirectory}/${journal}: the caller journal reaches step attempt null; expected the Durable history's 2`,
    });
  });
});

describe('retryMechanismOf', () => {
  it('names redelivery above one receive and a step retry above one attempt', () => {
    assert.equal(retryMechanismOf(1, null), 'none');
    assert.equal(retryMechanismOf(1, 1), 'none');
    assert.equal(retryMechanismOf(2, null), 'source_redelivery');
    assert.equal(retryMechanismOf(2, 1), 'source_redelivery');
    assert.equal(retryMechanismOf(1, 2), 'durable_step_retry');
    assert.equal(retryMechanismOf(2, 2), 'source_redelivery_and_durable_step_retry');
  });
});

describe('commitGapSeconds', () => {
  it('measures the first two commits in seconds, or null with fewer than two', () => {
    const at = (...values: string[]): readonly UtcMillis[] => values as UtcMillis[];
    assert.equal(commitGapSeconds(at()), null);
    assert.equal(commitGapSeconds(at('2026-10-07T06:12:11.884Z')), null);
    assert.equal(commitGapSeconds(at('2026-10-07T06:12:11.884Z', '2026-10-07T06:13:10.989Z')), 59.105);
    assert.equal(
      commitGapSeconds(at('2026-10-07T06:12:11.884Z', '2026-10-07T06:13:10.989Z', '2026-10-07T07:00:00.000Z')),
      59.105,
    );
  });
});
