// The canonical run's verdicts re-derived from the public redacted copy (close-out Phase 3). The
// ledger rules decide a valid trial's preservation verdict: BR-RUA-001 (one successful transaction
// for the request), BR-RUA-002 (the payment's successful total within its captured amount) and
// BR-RUA-009 (the successful set is exactly the one authorized effect). Each is recomputed from the
// redacted ledger, payment and approved decision and must equal the original oracle result, so the
// redaction provably left every verdict input intact.

import { sha256Hex } from '../../src/record-contract/digests.ts';
import type { JsonObject } from '../../src/record-contract/primitives.ts';
import type { EvidencePackage } from './study-results-reading.ts';
import {
  booleanOf,
  integerOf,
  objectOf,
  objectsOf,
  parseRecord,
  readRecord,
  stringOf,
} from './study-results-reading.ts';

export type LedgerRuleId = 'BR-RUA-001' | 'BR-RUA-002' | 'BR-RUA-009';
export type LedgerResult = 'pass' | 'fail';

/** One ledger rule: its result from the redacted ledger beside the original oracle's. */
export interface RuleRecheck {
  readonly rule_id: LedgerRuleId;
  readonly redacted_ledger: LedgerResult;
  readonly oracle_result: string;
}

/** One trial's verdict re-derived from the redacted copy, with the ledger digests on both sides. */
export interface TrialRecheck {
  readonly trial_id: string;
  readonly scenario: string;
  readonly variant_id: string;
  readonly ledger_path: string;
  readonly original_ledger_sha256: string;
  readonly redacted_ledger_sha256: string;
  readonly rules: readonly RuleRecheck[];
  readonly preservation_verdict: { readonly redacted_ledger: LedgerResult; readonly oracle_result: string };
}

/** The bytes of one redacted file by its path relative to the evidence root; undefined when absent. */
export type RedactedFileReader = (path: string) => Uint8Array | undefined;

/** The one effect the approved decision authorizes (BR-RUA-009). */
interface AuthorizedEffect {
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}

/** One redacted file: its path relative to the evidence root, its bytes and its one record. */
interface RedactedRecord {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly record: JsonObject;
  readonly subject: string;
}

/** What the ledger rules compare the ledger with: the authorized effect and the captured amount. */
interface TrialInputs {
  readonly effect: AuthorizedEffect;
  readonly captured_minor: number;
}

const LEDGER_RULES: readonly LedgerRuleId[] = ['BR-RUA-001', 'BR-RUA-002', 'BR-RUA-009'];
const ORACLE_RESULT = /^trials\/[^/]+\/derived\/oracle-result\.json$/;

/**
 * Every trial of the run package `original`, its ledger rules and preservation verdict recomputed
 * from the redacted copy and refused unless each equals the original oracle result.
 *
 * @example
 * recheckRunVerdicts(loadPackage('runs/<id>', read), (path) => copy.get(path)).map((one) => one.preservation_verdict.redacted_ledger);
 */
export function recheckRunVerdicts(original: EvidencePackage, redacted: RedactedFileReader): readonly TrialRecheck[] {
  return [...original.files.keys()]
    .filter((path) => ORACLE_RESULT.test(path))
    .map((path) => recheckTrial(original, path, redacted));
}

function recheckTrial(original: EvidencePackage, oraclePath: string, redacted: RedactedFileReader): TrialRecheck {
  const subject = `${original.directory}/${oraclePath}`;
  const oracle = readRecord(original, oraclePath).record;
  const trialId = stringOf(oracle, 'trial_id', subject);
  const validity = stringOf(oracle, 'trial_validity', subject);
  if (validity !== 'valid') {
    throw new Error(
      `${subject}: trial_validity is ${validity}; expected valid, the only trial a ledger verdict decides`,
    );
  }
  const trial = `${original.directory}/trials/${trialId}`;
  const ledger = redactedRecord(redacted, `${trial}/ledger/ledger-snapshot.json`);
  const results = ledgerResults(ledger, trialInputs(redacted, trial));
  const oracleResults = new Map(
    objectsOf(oracle, 'rule_results', subject).map((rule) => [
      stringOf(rule, 'rule_id', subject),
      stringOf(rule, 'result', subject),
    ]),
  );
  const rules = LEDGER_RULES.map((ruleId) => ({
    rule_id: ruleId,
    redacted_ledger: results[ruleId],
    oracle_result: oracleResults.get(ruleId) ?? 'absent',
  }));
  const verdict: LedgerResult = rules.every((rule) => rule.redacted_ledger === 'pass') ? 'pass' : 'fail';
  const preservation = { redacted_ledger: verdict, oracle_result: stringOf(oracle, 'preservation_verdict', subject) };
  assertAgreement(subject, rules, preservation);
  const manifestPath = `trials/${trialId}/trial-manifest.json`;
  const manifestSubject = `${original.directory}/${manifestPath}`;
  const manifest = readRecord(original, manifestPath).record;
  return {
    trial_id: trialId,
    scenario: stringOf(manifest, 'scenario', manifestSubject),
    variant_id: stringOf(manifest, 'variant_id', manifestSubject),
    ledger_path: ledger.path,
    original_ledger_sha256: stringOf(objectOf(oracle, 'ledger_snapshot_ref', subject), 'artifact_sha256', subject),
    redacted_ledger_sha256: sha256Hex(ledger.bytes),
    rules,
    preservation_verdict: preservation,
  };
}

function redactedRecord(redacted: RedactedFileReader, path: string): RedactedRecord {
  const bytes = redacted(path);
  if (bytes === undefined) {
    throw new Error(`the redacted copy holds no ${path}; expected every file of the original package`);
  }
  const subject = `redacted ${path}`;
  return { path, bytes, record: parseRecord(bytes, subject), subject };
}

function trialInputs(redacted: RedactedFileReader, trial: string): TrialInputs {
  const payment = redactedRecord(redacted, `${trial}/inputs/payment.json`);
  const decision = redactedRecord(redacted, `${trial}/inputs/approved-decision.json`);
  return {
    effect: {
      refund_request_id: stringOf(decision.record, 'refund_request_id', decision.subject),
      payment_id: stringOf(payment.record, 'payment_id', payment.subject),
      amount_minor: integerOf(decision.record, 'approved_amount_minor', decision.subject),
      currency: stringOf(decision.record, 'currency', decision.subject),
    },
    captured_minor: integerOf(payment.record, 'captured_amount_minor', payment.subject),
  };
}

// The three ledger rules over the SUCCEEDED transactions of a complete snapshot, summed exactly.
function ledgerResults(ledger: RedactedRecord, inputs: TrialInputs): Readonly<Record<LedgerRuleId, LedgerResult>> {
  const { record, subject } = ledger;
  const { effect } = inputs;
  if (!booleanOf(record, 'complete', subject)) {
    throw new Error(`${subject}: complete is false; expected a complete ledger snapshot`);
  }
  const successful = objectsOf(record, 'transactions', subject).filter(
    (transaction) => stringOf(transaction, 'status', subject) === 'SUCCEEDED',
  );
  const forRequest = successful.filter(
    (transaction) => stringOf(transaction, 'refund_request_id', subject) === effect.refund_request_id,
  );
  const paidMinor = successful
    .filter((transaction) => stringOf(transaction, 'payment_id', subject) === effect.payment_id)
    .reduce((sum, transaction) => sum + BigInt(integerOf(transaction, 'amount_minor', subject)), 0n);
  const authorized = successful.filter((transaction) => isAuthorizedEffect(transaction, effect, subject));
  return {
    'BR-RUA-001': resultOf(forRequest.length === 1),
    'BR-RUA-002': resultOf(paidMinor <= BigInt(inputs.captured_minor)),
    'BR-RUA-009': resultOf(authorized.length === 1 && successful.length === 1),
  };
}

function isAuthorizedEffect(transaction: JsonObject, effect: AuthorizedEffect, subject: string): boolean {
  return (
    stringOf(transaction, 'refund_request_id', subject) === effect.refund_request_id &&
    stringOf(transaction, 'payment_id', subject) === effect.payment_id &&
    integerOf(transaction, 'amount_minor', subject) === effect.amount_minor &&
    stringOf(transaction, 'currency', subject) === effect.currency
  );
}

function resultOf(holds: boolean): LedgerResult {
  return holds ? 'pass' : 'fail';
}

function assertAgreement(
  subject: string,
  rules: readonly RuleRecheck[],
  preservation: TrialRecheck['preservation_verdict'],
): void {
  const differing = [...rules, { rule_id: 'preservation_verdict', ...preservation }]
    .filter((one) => one.redacted_ledger !== one.oracle_result)
    .map((one) => `${one.rule_id} ${one.redacted_ledger} where the oracle has ${one.oracle_result}`);
  if (differing.length > 0) {
    throw new Error(`${subject}: the redacted ledger gives ${differing.join('; ')}; expected the oracle's results`);
  }
}
