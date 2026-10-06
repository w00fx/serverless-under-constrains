// The monetary rules BR-RUA-001, -002 and -009 and the monetary observations (design §8.5, D-15,
// INV-RUA-001). They read only the ledger snapshot, the payment and the approved decision
// (BR-RUA-005, AC-RUA-006) and cite only those files: the ledger whole, plus a JSON pointer per
// transaction a rule counts. Their `observed` values always carry the counts and sums the ledger
// shows; the verdict on them is conclusive only on a conclusive basis, and indeterminate with the
// basis reasons otherwise. The observations are reported whatever the basis.

import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { compareDecimal, sumMinorUnits } from '../record-contract/decimal.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { DecimalString, JsonObject, JsonValue } from '../record-contract/primitives.ts';
import type { LedgerTransaction } from '../record-contract/records/group-b/ledger_snapshot.ts';
import type { MonetaryObservations, RuleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { OracleRuleId } from '../record-contract/records/group-c/vocabulary.ts';
import { canonicalRefs } from '../treatment-fidelity/condition-result.ts';
import { subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { MonetaryBasis } from './monetary-basis.ts';
import type { BusinessInputs } from './oracle-inputs.ts';

export interface MonetaryRuleResults {
  readonly one_effect: RuleResult;
  readonly payment_limit: RuleResult;
  readonly exact_effect: RuleResult;
  readonly observations: MonetaryObservations;
}

/** One ledger transaction with the pointer that cites it. */
interface CitedTransaction {
  readonly transaction: LedgerTransaction;
  readonly ref: EvidenceRef;
}

/** BR-RUA-009's tuple, with `null` for a value whose input is missing. */
interface AuthorizedEffect {
  readonly refund_request_id: string | null;
  readonly payment_id: string | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly status: 'SUCCEEDED';
}

const TUPLE_FIELDS = ['refund_request_id', 'payment_id', 'amount_minor', 'currency', 'status'] as const;

/**
 * Evaluates the three monetary rules and the monetary observations.
 *
 * @example
 * evaluateMonetaryRules(evidence, businessInputs(evidence), { conclusive: true }).one_effect.result; // 'pass'
 */
export function evaluateMonetaryRules(
  evidence: IngestedEvidence,
  inputs: BusinessInputs,
  basis: MonetaryBasis,
): MonetaryRuleResults {
  // The ledger file is cited whenever it was given, usable or not, so an indeterminate rule over an
  // unreadable snapshot still names it (BR-RUA-035; fuzz seed 20261006).
  const ledgerRef = subjectArtifactState(evidence, 'ledger_snapshot').ref;
  const cited = citedTransactions(evidence.ledger.snapshot?.record.transactions ?? [], ledgerRef);
  const sourceRefs = [ledgerRef, inputs.decision.ref, inputs.payment.ref].filter(
    (ref): ref is EvidenceRef => ref !== undefined,
  );
  const decision = inputs.decision.record;
  const payment = inputs.payment.record;
  const effect: AuthorizedEffect = {
    refund_request_id: decision?.refund_request_id ?? null,
    payment_id: payment?.payment_id ?? null,
    amount_minor: decision?.approved_amount_minor ?? null,
    currency: decision?.currency ?? null,
    status: 'SUCCEEDED',
  };
  const judge = (
    ruleId: OracleRuleId,
    holds: boolean,
    expected: JsonValue,
    observed: JsonValue,
    counted: readonly CitedTransaction[],
  ): RuleResult =>
    ruleResult(ruleId, basis, holds, {
      expected,
      observed,
      refs: [...sourceRefs, ...counted.map((entry) => entry.ref)],
    });
  const forRequest = cited.filter((entry) => entry.transaction.refund_request_id === effect.refund_request_id);
  const forPayment = cited.filter(
    (entry) => effect.payment_id === null || entry.transaction.payment_id === effect.payment_id,
  );
  const paid = sumMinorUnits(forPayment.map((entry) => entry.transaction.amount_minor));
  const cap = payment?.captured_amount_minor ?? null;
  const exact = cited.map((entry) => ({ entry, mismatches: mismatchesOf(entry.transaction, effect) }));
  return {
    one_effect: judge(
      'BR-RUA-001',
      forRequest.length === 1,
      { count: 1, refund_request_id: effect.refund_request_id },
      {
        count: effect.refund_request_id === null ? null : forRequest.length,
        provider_transaction_ids: idsOf(forRequest),
      },
      forRequest,
    ),
    payment_limit: judge(
      'BR-RUA-002',
      cap !== null && compareDecimal(paid, String(cap) as DecimalString) <= 0,
      { max_total_minor: cap, payment_id: effect.payment_id },
      { total_minor: paid, transaction_count: forPayment.length },
      forPayment,
    ),
    exact_effect: judge(
      'BR-RUA-009',
      exact.length === 1 && exact.every((candidate) => candidate.mismatches.length === 0),
      [{ ...effect }],
      { transactions: exact.map(({ entry, mismatches }) => transactionObservation(entry.transaction, mismatches)) },
      cited,
    ),
    observations: monetaryObservations(evidence),
  };
}

function ruleResult(
  ruleId: OracleRuleId,
  basis: MonetaryBasis,
  holds: boolean,
  values: { readonly expected: JsonValue; readonly observed: JsonValue; readonly refs: readonly EvidenceRef[] },
): RuleResult {
  const refs = canonicalRefs(values.refs);
  if (!basis.conclusive) {
    const reasons = basis.reasons.map((reason) => ({ ...reason, subject: ruleId }));
    return {
      rule_id: ruleId,
      result: 'indeterminate',
      expected: values.expected,
      observed: values.observed,
      evidence_refs: refs,
      indeterminate_reasons: reasons,
    };
  }
  return {
    rule_id: ruleId,
    result: holds ? 'pass' : 'fail',
    expected: values.expected,
    observed: values.observed,
    evidence_refs: refs,
    indeterminate_reasons: [],
  };
}

// A transaction exists only in a present snapshot, whose file was given, so a transaction always
// has the ledger to cite.
function citedTransactions(
  transactions: readonly LedgerTransaction[],
  ledgerRef: EvidenceRef | undefined,
): readonly CitedTransaction[] {
  return ledgerRef === undefined
    ? []
    : transactions.map((transaction, index) => ({
        transaction,
        ref: { ...ledgerRef, json_pointer: `/transactions/${String(index)}` },
      }));
}

// Field-level mismatches against the authorized effect; a field whose input is missing is unknown,
// never a mismatch.
function mismatchesOf(transaction: LedgerTransaction, effect: AuthorizedEffect): readonly string[] {
  return TUPLE_FIELDS.filter((field) => effect[field] !== null && transaction[field] !== effect[field]);
}

function transactionObservation(transaction: LedgerTransaction, mismatches: readonly string[]): JsonObject {
  return {
    provider_transaction_id: transaction.provider_transaction_id,
    refund_request_id: transaction.refund_request_id,
    payment_id: transaction.payment_id,
    amount_minor: transaction.amount_minor,
    currency: transaction.currency,
    status: transaction.status,
    mismatches: [...mismatches],
  };
}

function idsOf(entries: readonly CitedTransaction[]): readonly string[] {
  return entries.map((entry) => entry.transaction.provider_transaction_id);
}

function monetaryObservations(evidence: IngestedEvidence): MonetaryObservations {
  // The ledger snapshot schema admits only SUCCEEDED transactions (LEDGER_TRANSACTION_STATUSES), so
  // every stored transaction is a successful one; ingestion rejects any other status.
  const successful = evidence.ledger.transactions;
  return {
    successful_transaction_count: successful.length,
    refunded_total_minor: sumMinorUnits(successful.map((transaction) => transaction.amount_minor)),
    provider_transaction_ids: successful.map((transaction) => transaction.provider_transaction_id),
    ledger_complete: evidence.ledger.pagination_complete,
  };
}
