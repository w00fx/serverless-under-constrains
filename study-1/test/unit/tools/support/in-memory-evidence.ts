// An evidence root held in memory, with package builders shaped like the operator CLI's packages,
// for the derived Study 1 results tests. Every package gets a package-index.json whose entries
// carry the true byte count and SHA-256 of each file, unless a test corrupts it on purpose.

import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { EvidenceFileReader } from '../../../../tools/lib/study-results-reading.ts';

/** A parsed record a test may edit in place before it is serialized again. */
export type EditableRecord = Record<string, unknown>;

/** File contents: a JSON value or editable record to serialize, or raw text such as a JSONL journal. */
export type FileContent = JsonValue | EditableRecord | string;
export type FileMap = Map<string, FileContent>;

export interface TrialFixture {
  readonly id: string;
  readonly sequence: number;
  readonly scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT';
  readonly variant: 'conventional' | 'durable';
  readonly commits: readonly string[];
  readonly receiveCounts: readonly number[];
  readonly verdict: 'pass' | 'fail';
}

export const RUN_ID = '00000000-0000-4000-8000-000000000001';
export const VALIDATION_ID = '00000000-0000-4000-8000-000000000002';
export const PROBE_ID = '00000000-0000-4000-8000-0000000000aa';
export const PROBE_INDEX = 'a'.repeat(64);
export const COMMIT = 'c'.repeat(40);

export const CONTROL_CONVENTIONAL: TrialFixture = {
  id: '10000000-0000-4000-8000-000000000001',
  sequence: 1,
  scenario: 'CONTROL',
  variant: 'conventional',
  commits: ['2026-10-07T06:00:00.000Z'],
  receiveCounts: [1],
  verdict: 'pass',
};

export const TIMEOUT_DURABLE: TrialFixture = {
  id: '10000000-0000-4000-8000-000000000002',
  sequence: 2,
  scenario: 'COMMIT_THEN_TIMEOUT',
  variant: 'durable',
  commits: ['2026-10-07T06:01:04.095Z', '2026-10-07T06:00:00.000Z'],
  receiveCounts: [1, 1],
  verdict: 'fail',
};

/** SHA-256 hex of the bytes a file content serializes to. */
export function digestOf(content: FileContent): string {
  return createHash('sha256').update(bytesOf(content)).digest('hex');
}

/** The bytes a file content serializes to. */
export function bytesOf(content: FileContent): Uint8Array {
  return new TextEncoder().encode(typeof content === 'string' ? content : JSON.stringify(content));
}

/** An evidence root in memory; reading an absent path throws as the file system would. */
export class InMemoryEvidence {
  private readonly contents = new Map<string, Uint8Array>();

  /** Stores one file under the evidence root. */
  put(path: string, content: FileContent): void {
    this.contents.set(path, bytesOf(content));
  }

  /** Stores every file of a package and an index of their true sizes and digests. */
  putPackage(directory: string, files: FileMap): void {
    const entries = [...files].map(([path, content]) => ({
      artifact_path: path,
      bytes: bytesOf(content).length,
      sha256: digestOf(content),
    }));
    for (const [path, content] of files) {
      this.put(`${directory}/${path}`, content);
    }
    this.put(`${directory}/package-index.json`, { entries });
  }

  /** The SHA-256 of the stored package index of `directory`. */
  indexDigest(directory: string): string {
    return createHash('sha256')
      .update(this.read(`${directory}/package-index.json`))
      .digest('hex');
  }

  readonly read: EvidenceFileReader = (path) => {
    const bytes = this.contents.get(path);
    if (bytes === undefined) {
      throw new Error(`ENOENT: no such file ${path}`);
    }
    return bytes;
  };
}

/** The files of one trial: manifest, oracle result, ledger, caller journal and Durable history. */
export function trialFiles(trial: TrialFixture): FileMap {
  const directory = `trials/${trial.id}`;
  const files: FileMap = new Map();
  files.set(`${directory}/trial-manifest.json`, { scenario: trial.scenario, variant_id: trial.variant });
  files.set(`${directory}/derived/oracle-result.json`, {
    preservation_verdict: trial.verdict,
    correct_completion: trial.verdict === 'pass',
    trial_validity: 'valid',
    treatment_fidelity: 'faithful',
    monetary_observations: {
      successful_transaction_count: trial.commits.length,
      refunded_total_minor: String(trial.commits.length * 10000),
    },
  });
  files.set(`${directory}/ledger/ledger-snapshot.json`, {
    complete: true,
    transactions: [
      ...trial.commits.map((at) => ({
        status: 'SUCCEEDED',
        currency: 'BRL',
        amount_minor: 10000,
        commit_requested_at: at,
      })),
      { status: 'FAILED', currency: 'USD', amount_minor: 5, commit_requested_at: 'not-a-time' },
    ],
  });
  files.set(`${directory}/journals/caller-journal.jsonl`, callerJournal(trial));
  if (trial.variant === 'durable') {
    files.set(`${directory}/execution-metadata/durable-executions.json`, {
      list_complete: true,
      executions: [
        { status: 'SUCCEEDED', history_complete: true, history: durableHistory(trial.receiveCounts.length) },
      ],
    });
  }
  return files;
}

/** One execution package: admission, summary and safety records plus its trials' files. */
export function executionFiles(
  kind: 'run' | 'variant_validation',
  id: string,
  trials: readonly TrialFixture[],
  editTrials: (files: FileMap) => void = () => undefined,
): FileMap {
  const files: FileMap = new Map(trials.flatMap((trial) => [...trialFiles(trial)]));
  editTrials(files);
  files.set('admission/execution-manifest.json', {
    qualification: { transport_probe_id: PROBE_ID, original_package_index_sha256: PROBE_INDEX },
  });
  files.set('admission/source-provenance.json', { commit_sha: COMMIT });
  files.set('summary/safety-assessment.json', safetyAssessment());
  files.set(kind === 'run' ? 'summary/run-summary.json' : 'summary/validation-summary.json', {
    ...(kind === 'run'
      ? { record_type: 'run_summary', run_id: id, run_terminal_reason: 'COMPLETED', comparison_eligibility: 'eligible' }
      : {
          record_type: 'validation_summary',
          variant_validation_id: id,
          validation_terminal_reason: 'COMPLETED',
          implementation_validation_status: 'verified',
          validation_validity: 'valid',
        }),
    execution_status: 'completed',
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    evidence_integrity_status: 'verified',
    trial_results: trials.map((trial) => summaryEntry(trial, files)),
  });
  return files;
}

/** A copy of one JSON object file of a file map, for tests that edit one record. */
export function editableIn(files: FileMap, path: string): EditableRecord {
  const content = files.get(path);
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new Error(`fixture ${path} is ${JSON.stringify(content)}; expected a JSON object`);
  }
  return structuredClone(content) as EditableRecord;
}

/** The first element of an array-of-objects member, for tests that edit one element in place. */
export function firstOf(record: EditableRecord, name: string): EditableRecord {
  const list = record[name];
  const [first] = Array.isArray(list) ? (list as unknown[]) : [];
  if (typeof first !== 'object' || first === null) {
    throw new Error(`fixture ${name} is ${JSON.stringify(list)}; expected an array of objects`);
  }
  return first as EditableRecord;
}

function summaryEntry(trial: TrialFixture, files: FileMap): EditableRecord {
  const oraclePath = `trials/${trial.id}/derived/oracle-result.json`;
  const oracle = editableIn(files, oraclePath);
  return {
    trial_id: trial.id,
    sequence: trial.sequence,
    scenario: trial.scenario,
    variant_id: trial.variant,
    preservation_verdict: oracle['preservation_verdict'] ?? null,
    correct_completion: oracle['correct_completion'] ?? null,
    oracle_result_ref: { artifact_path: oraclePath, artifact_sha256: digestOf(oracle) },
  };
}

function callerJournal(trial: TrialFixture): string {
  const durable = trial.variant === 'durable';
  const lines = trial.receiveCounts.map((count, index) => ({
    record_type: 'caller_invocation_started',
    approximate_receive_count: count,
    ...(durable ? { step_attempt: index + 1 } : {}),
  }));
  return [...lines, { record_type: 'caller_invocation_completed' }].map((line) => JSON.stringify(line)).join('\n');
}

function durableHistory(attempts: number): JsonObject[] {
  return [
    { event_type: 'ExecutionStarted' },
    ...Array.from({ length: attempts }, (_, index) => ({ event_type: 'StepStarted', current_attempt: index + 1 })),
    { event_type: 'ExecutionSucceeded' },
  ];
}

function safetyAssessment(): JsonObject {
  return {
    safety_status: 'within_limits',
    checks: [
      { boundary: 'ACTIVE_TIME', observed: '1131625 ms', declared_limit: '4500000 ms', result: 'within_limits' },
      { boundary: 'TOTAL_TIME', observed: '1512585 ms', declared_limit: '5400000 ms', result: 'within_limits' },
      { boundary: 'ESTIMATED_COST', observed: '0.28 USD', declared_limit: '5.00 USD', result: 'within_limits' },
    ],
  };
}
