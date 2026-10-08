// Evidence packages for the public redacted copy tests (close-out Phase 3): a run whose trials hold
// a ledger, the trial inputs and an oracle result with the ledger rules, and files that name the
// sandbox account and the owner's local paths the way the real packages do (ARNs, bucket names,
// queue URLs, CDK stack traces through the checkout, the admission's golden report under
// /var/folders).

import { createHash } from 'node:crypto';

import type { RedactedFileReader } from '../../../../tools/lib/redacted-verdicts.ts';
import type { EvidenceFileReader } from '../../../../tools/lib/study-results-reading.ts';
import type { FileContent, FileMap } from './in-memory-evidence.ts';
import { digestOf, InMemoryEvidence } from './in-memory-evidence.ts';

export const ACCOUNT = '123456789012';
export const RUN = 'runs/00000000-0000-4000-8000-000000000001';
export const VALIDATION = 'variant-validations/00000000-0000-4000-8000-000000000002';
export const PROBE = 'transport-probes/00000000-0000-4000-8000-0000000000aa';
export const CHECKOUT = '/Users/alice/Projects/suc/.agent-runs/r/worktrees/cloud-run/';
export const TEMP = '/var/folders/zz/q1w2e3r4t5y6_example/T/';

export type LedgerRuleResults = Readonly<Record<'BR-RUA-001' | 'BR-RUA-002' | 'BR-RUA-009', string>>;

export interface LedgerTransaction {
  readonly status: string;
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}

/** One trial: its successful and failed transactions and what its oracle result states. */
export interface LedgerTrial {
  readonly id: string;
  readonly transactions: readonly LedgerTransaction[];
  readonly rules: LedgerRuleResults;
  readonly verdict: string;
  readonly validity?: string;
  readonly complete?: boolean;
}

/** The one effect the trial inputs authorize: request ref-1 on payment pay-1, 10000 BRL. */
export const AUTHORIZED: LedgerTransaction = {
  status: 'SUCCEEDED',
  refund_request_id: 'ref-1',
  payment_id: 'pay-1',
  amount_minor: 10000,
  currency: 'BRL',
};

export const PASSING: LedgerTrial = {
  id: '20000000-0000-4000-8000-000000000001',
  transactions: [AUTHORIZED, { ...AUTHORIZED, status: 'FAILED' }],
  rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
  verdict: 'pass',
};

export const DOUBLE_REFUND: LedgerTrial = {
  id: '20000000-0000-4000-8000-000000000002',
  transactions: [AUTHORIZED, AUTHORIZED],
  rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
  verdict: 'fail',
};

/** The files of one trial, with a caller journal that names the account in an execution ARN. */
export function ledgerTrialFiles(trial: LedgerTrial): FileMap {
  const directory = `trials/${trial.id}`;
  const ledger = { complete: trial.complete ?? true, transactions: trial.transactions };
  return new Map<string, FileContent>([
    [`${directory}/trial-manifest.json`, { scenario: 'CONTROL', variant_id: 'durable' }],
    [`${directory}/ledger/ledger-snapshot.json`, ledger],
    [`${directory}/inputs/payment.json`, { payment_id: 'pay-1', captured_amount_minor: 10000 }],
    [
      `${directory}/inputs/approved-decision.json`,
      { refund_request_id: 'ref-1', approved_amount_minor: 10000, currency: 'BRL' },
    ],
    [
      `${directory}/derived/oracle-result.json`,
      {
        trial_id: trial.id,
        trial_validity: trial.validity ?? 'valid',
        preservation_verdict: trial.verdict,
        rule_results: Object.entries(trial.rules).map(([rule_id, result]) => ({ rule_id, result })),
        ledger_snapshot_ref: { artifact_sha256: digestOf(ledger) },
      },
    ],
    [
      `${directory}/journals/caller-journal.jsonl`,
      `{"execution_arn":"arn:aws:lambda:us-east-1:${ACCOUNT}:function:caller:live/durable-execution/x"}\n`,
    ],
  ]);
}

/** A run package with `trials` and admission files that name the checkout and a temp directory. */
export function runPackageFiles(trials: readonly LedgerTrial[]): FileMap {
  const files = new Map<string, FileContent>([
    [
      'admission/deployment-assembly/stack.metadata.json',
      { trace: [`new ExecutionStack (file://${CHECKOUT}study-1/infra/stacks/execution-stack.ts:89:17)`] },
    ],
    ['admission/oracle-attestation.json', { command: `npm run test:golden -- --report-json ${TEMP}rua-g/report.json` }],
    ['admission/deployment-assembly/asset.1/index.mjs', 'export const region = "us-east-1";\n'],
  ]);
  for (const trial of trials) {
    for (const [path, content] of ledgerTrialFiles(trial)) {
      files.set(path, content);
    }
  }
  return files;
}

/** A probe package whose provisioning record names the account in a bucket and a queue URL. */
export function probePackageFiles(): FileMap {
  return new Map<string, FileContent>([
    [
      'provisioning/stack.json',
      {
        bucket: `cdk-hnb659fds-assets-${ACCOUNT}-us-east-1`,
        queue_url: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/source`,
        account: ACCOUNT,
        role_arn: `arn:aws:iam::${ACCOUNT}:role/deployer`,
      },
    ],
  ]);
}

/** The evidence root of the redaction tests: a run with `trials` and a probe. */
export function redactionEvidence(trials: readonly LedgerTrial[] = [PASSING, DOUBLE_REFUND]): InMemoryEvidence {
  const evidence = new InMemoryEvidence();
  evidence.putPackage(RUN, runPackageFiles(trials));
  evidence.putPackage(PROBE, probePackageFiles());
  return evidence;
}

/**
 * A redacted copy that holds the evidence's own bytes, except each overridden path: replaced by
 * its bytes, or absent when overridden with undefined.
 */
export function redactedReader(
  evidence: InMemoryEvidence,
  overrides: ReadonlyMap<string, Uint8Array | undefined> = new Map(),
): RedactedFileReader {
  return (path) => (overrides.has(path) ? overrides.get(path) : evidence.read(path));
}

/** A package of raw bytes, such as text that is not UTF-8, with a true package index. */
export function rawPackageReader(directory: string, files: ReadonlyMap<string, Uint8Array>): EvidenceFileReader {
  const entries = [...files].map(([path, bytes]) => ({
    artifact_path: path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const stored = new Map([...files].map(([path, bytes]) => [`${directory}/${path}`, bytes]));
  stored.set(`${directory}/package-index.json`, new TextEncoder().encode(JSON.stringify({ entries })));
  return (path) => {
    const bytes = stored.get(path);
    if (bytes === undefined) {
      throw new Error(`ENOENT: no such file ${path}`);
    }
    return bytes;
  };
}
