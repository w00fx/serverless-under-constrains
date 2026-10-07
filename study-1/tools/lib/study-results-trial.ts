// One trial of the derived Study 1 results (close-out Phase 1). Each part comes from a frozen source:
// - the verdict is what the frozen oracle result states;
// - the money is what the frozen ledger snapshot shows, cross-checked with the oracle's monetary
//   observations;
// - the retry path is what the caller journal and the Durable execution history recorded,
//   cross-checked with each other.
// No member is typed by hand: each is read from a cited artifact, and a disagreement between two
// sources stops the derivation instead of choosing one.

import { signedDifferenceMs, sumMinorUnits } from '../../src/record-contract/decimal.ts';
import type { JsonObject, UtcMillis } from '../../src/record-contract/primitives.ts';
import { isUtcMillis } from '../../src/record-contract/timestamps.ts';
import type { ArtifactRef, CitedRecord, EvidencePackage } from './study-results-reading.ts';
import {
  booleanOf,
  byArtifactPath,
  holdsFile,
  integerOf,
  memberOf,
  objectOf,
  objectsOf,
  readLines,
  readRecord,
  stringOf,
} from './study-results-reading.ts';

export const RETRY_MECHANISMS = [
  'none',
  'source_redelivery',
  'durable_step_retry',
  'source_redelivery_and_durable_step_retry',
] as const;
export type RetryMechanism = (typeof RETRY_MECHANISMS)[number];

/** One Durable execution of a trial, as its frozen history recorded it. */
export interface DurableExecutionResult {
  readonly status: string;
  readonly final_history_event: string;
  readonly highest_step_attempt: number;
}

/** How the trial's request was retried, from the caller journal and the Durable history. */
export interface TrialRetryPath {
  readonly mechanism: RetryMechanism;
  readonly source_receive_count: number;
  readonly durable_step_attempt: number | null;
  readonly durable_executions: readonly DurableExecutionResult[];
}

/** One trial's derived result. */
export interface TrialResult {
  readonly trial_id: string;
  readonly sequence: number;
  readonly scenario: string;
  readonly variant_id: string;
  readonly preservation_verdict: string;
  readonly correct_completion: boolean;
  readonly trial_validity: string;
  readonly treatment_fidelity: string;
  readonly successful_transaction_count: number;
  readonly refunded_total_minor: string;
  readonly currency: string | null;
  readonly commit_times: readonly UtcMillis[];
  readonly commit_gap_seconds: number | null;
  readonly retry: TrialRetryPath;
  readonly evidence_refs: readonly ArtifactRef[];
}

interface LedgerMoney {
  readonly count: number;
  readonly total: string;
  readonly currency: string | null;
  readonly commitTimes: readonly UtcMillis[];
}

interface DurableEvidence {
  readonly executions: readonly DurableExecutionResult[];
  readonly refs: readonly ArtifactRef[];
}

const DURABLE_METADATA = 'execution-metadata/durable-executions.json';

/**
 * The derived result of the trial one summary entry names.
 *
 * @example
 * deriveTrialResult(pkg, summary.trial_results[0]).preservation_verdict; // 'pass'
 */
export function deriveTrialResult(pkg: EvidencePackage, summaryEntry: JsonObject): TrialResult {
  const trialId = stringOf(summaryEntry, 'trial_id', `${pkg.directory} summary trial`);
  const directory = `trials/${trialId}`;
  const manifest = readRecord(pkg, `${directory}/trial-manifest.json`);
  const oracle = citedOracleResult(pkg, summaryEntry);
  const ledger = readRecord(pkg, `${directory}/ledger/ledger-snapshot.json`);
  const caller = readLines(pkg, `${directory}/journals/caller-journal.jsonl`);
  const subject = `${pkg.directory}/${directory}`;
  const variantId = stringOf(manifest.record, 'variant_id', `${subject}/trial-manifest.json`);
  const money = ledgerMoney(ledger.record, `${subject}/ledger/ledger-snapshot.json`);
  assertOracleMoney(oracle.record, money, `${subject}/derived/oracle-result.json`);
  const durable = durableEvidence(pkg, directory, variantId);
  const oracleSubject = `${subject}/derived/oracle-result.json`;
  return {
    trial_id: trialId,
    sequence: integerOf(summaryEntry, 'sequence', `${pkg.directory} summary trial ${trialId}`),
    scenario: stringOf(manifest.record, 'scenario', `${subject}/trial-manifest.json`),
    variant_id: variantId,
    preservation_verdict: stringOf(oracle.record, 'preservation_verdict', oracleSubject),
    correct_completion: booleanOf(oracle.record, 'correct_completion', oracleSubject),
    trial_validity: stringOf(oracle.record, 'trial_validity', oracleSubject),
    treatment_fidelity: stringOf(oracle.record, 'treatment_fidelity', oracleSubject),
    successful_transaction_count: money.count,
    refunded_total_minor: money.total,
    currency: money.currency,
    commit_times: money.commitTimes,
    commit_gap_seconds: commitGapSeconds(money.commitTimes),
    retry: retryPath(caller.records, durable.executions, `${subject}/journals/caller-journal.jsonl`),
    evidence_refs: [manifest.ref, oracle.ref, ledger.ref, caller.ref, ...durable.refs].sort(byArtifactPath),
  };
}

/**
 * The oracle result of the trial a summary entry names, refused unless the summary cites exactly
 * the indexed bytes: otherwise the summary reports a verdict of other bytes.
 *
 * @example
 * citedOracleResult(pkg, summary.trial_results[0]).record.preservation_verdict; // 'pass'
 */
export function citedOracleResult(pkg: EvidencePackage, summaryEntry: JsonObject): CitedRecord {
  const trialId = stringOf(summaryEntry, 'trial_id', `${pkg.directory} summary trial`);
  const subject = `${pkg.directory}/trials/${trialId}`;
  const oracle = readRecord(pkg, `trials/${trialId}/derived/oracle-result.json`);
  const cited = objectOf(summaryEntry, 'oracle_result_ref', `${subject} summary entry`);
  const digest = stringOf(cited, 'artifact_sha256', `${subject} summary entry oracle_result_ref`);
  if (digest !== oracle.ref.artifact_sha256) {
    throw new Error(
      `${subject}: the summary cites oracle result ${digest}; expected the indexed ${oracle.ref.artifact_sha256}`,
    );
  }
  return oracle;
}

/**
 * The retry mechanism the receive count and the Durable step attempt show: more than one receive
 * is a source redelivery, a step attempt above one is a Durable step retry.
 *
 * @example
 * retryMechanismOf(2, null); // 'source_redelivery'
 */
export function retryMechanismOf(receiveCount: number, stepAttempt: number | null): RetryMechanism {
  const redelivered = receiveCount > 1;
  const stepRetried = (stepAttempt ?? 0) > 1;
  if (redelivered && stepRetried) {
    return 'source_redelivery_and_durable_step_retry';
  }
  if (redelivered) {
    return 'source_redelivery';
  }
  return stepRetried ? 'durable_step_retry' : 'none';
}

/**
 * Seconds from the first to the second successful commit, or null with fewer than two.
 *
 * @example
 * commitGapSeconds(['2026-10-07T06:12:11.884Z', '2026-10-07T06:13:10.989Z'] as UtcMillis[]); // 59.105
 */
export function commitGapSeconds(commitTimes: readonly UtcMillis[]): number | null {
  const [first, second] = commitTimes;
  if (first === undefined || second === undefined) {
    return null;
  }
  return Number(signedDifferenceMs(second, first)) / 1000;
}

function ledgerMoney(ledger: JsonObject, subject: string): LedgerMoney {
  if (!booleanOf(ledger, 'complete', subject)) {
    throw new Error(`${subject}: complete is false; expected a complete ledger snapshot`);
  }
  const successful = objectsOf(ledger, 'transactions', subject).filter(
    (transaction) => stringOf(transaction, 'status', subject) === 'SUCCEEDED',
  );
  const currencies = [...new Set(successful.map((transaction) => stringOf(transaction, 'currency', subject)))];
  if (currencies.length > 1) {
    throw new Error(`${subject}: successful transactions are in ${currencies.join(', ')}; expected one currency`);
  }
  return {
    count: successful.length,
    total: sumMinorUnits(successful.map((transaction) => integerOf(transaction, 'amount_minor', subject))),
    currency: currencies[0] ?? null,
    commitTimes: successful.map((transaction) => commitTimeOf(transaction, subject)).sort(),
  };
}

function commitTimeOf(transaction: JsonObject, subject: string): UtcMillis {
  const value = stringOf(transaction, 'commit_requested_at', subject);
  if (!isUtcMillis(value)) {
    throw new Error(
      `${subject}: commit_requested_at is ${JSON.stringify(value)}; expected a UTC millisecond timestamp`,
    );
  }
  return value;
}

function assertOracleMoney(oracle: JsonObject, money: LedgerMoney, subject: string): void {
  const observed = objectOf(oracle, 'monetary_observations', subject);
  const count = integerOf(observed, 'successful_transaction_count', subject);
  const total = stringOf(observed, 'refunded_total_minor', subject);
  if (count !== money.count || total !== money.total) {
    throw new Error(
      `${subject}: the oracle observed ${String(count)} transaction(s) totalling ${total}; ` +
        `expected the ledger's ${String(money.count)} totalling ${money.total}`,
    );
  }
}

function durableEvidence(pkg: EvidencePackage, directory: string, variantId: string): DurableEvidence {
  const path = `${directory}/${DURABLE_METADATA}`;
  if (!holdsFile(pkg, path)) {
    if (variantId === 'durable') {
      throw new Error(`${pkg.directory}/${path} is absent; expected the Durable execution history of a durable trial`);
    }
    return { executions: [], refs: [] };
  }
  const { record, ref } = readRecord(pkg, path);
  const subject = `${pkg.directory}/${path}`;
  if (!booleanOf(record, 'list_complete', subject)) {
    throw new Error(`${subject}: list_complete is false; expected a complete Durable execution listing`);
  }
  return {
    executions: objectsOf(record, 'executions', subject).map((one) => durableExecution(one, subject)),
    refs: [ref],
  };
}

function durableExecution(execution: JsonObject, subject: string): DurableExecutionResult {
  if (!booleanOf(execution, 'history_complete', subject)) {
    throw new Error(`${subject}: history_complete is false; expected a complete Durable execution history`);
  }
  const history = objectsOf(execution, 'history', subject);
  const last = history.at(-1);
  if (last === undefined) {
    throw new Error(`${subject}: history is empty; expected at least one history event`);
  }
  const attempts = history
    .filter((event) => memberOf(event, 'current_attempt') !== undefined)
    .map((event) => integerOf(event, 'current_attempt', subject));
  return {
    status: stringOf(execution, 'status', subject),
    final_history_event: stringOf(last, 'event_type', subject),
    highest_step_attempt: Math.max(0, ...attempts),
  };
}

function retryPath(
  caller: readonly JsonObject[],
  executions: readonly DurableExecutionResult[],
  subject: string,
): TrialRetryPath {
  const invocations = caller.filter((record) => memberOf(record, 'record_type') === 'caller_invocation_started');
  if (invocations.length === 0) {
    throw new Error(`${subject} holds no caller_invocation_started; expected at least one caller invocation`);
  }
  const receiveCount = Math.max(...invocations.map((one) => integerOf(one, 'approximate_receive_count', subject)));
  const stepAttempts = invocations
    .filter((one) => memberOf(one, 'step_attempt') !== undefined)
    .map((one) => integerOf(one, 'step_attempt', subject));
  const stepAttempt = stepAttempts.length === 0 ? null : Math.max(...stepAttempts);
  const historyAttempt = Math.max(0, ...executions.map((one) => one.highest_step_attempt));
  if (executions.length > 0 && historyAttempt !== (stepAttempt ?? 0)) {
    throw new Error(
      `${subject}: the caller journal reaches step attempt ${String(stepAttempt)}; ` +
        `expected the Durable history's ${String(historyAttempt)}`,
    );
  }
  return {
    mechanism: retryMechanismOf(receiveCount, stepAttempt),
    source_receive_count: receiveCount,
    durable_step_attempt: stepAttempt,
    durable_executions: executions,
  };
}
