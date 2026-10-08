// The monetary basis of D-15 (design §8.5): BR-RUA-001, -002 and -009 are conclusive only when
// G1, G5 and G6 are verified and the payment and decision are present. Otherwise each of them is
// indeterminate with the reasons named here:
//   - an absent ledger snapshot is ARTIFACT_MISSING at its path (ARTIFACT_INCOMPLETE when its file
//     is given but unreadable), and an absent payment or decision INPUT_MISSING at its path:
//     missing-evidence reasons (BR-RUA-035), so a rule that can cite nothing still names what is
//     missing;
//   - with the ledger present, LEDGER_NOT_INDEPENDENT (G1), LEDGER_INCOMPLETE (G5) and
//     SETTLEMENT_NOT_ESTABLISHED (G6) name each gate that is not verified, at the ledger snapshot
//     whose use as the monetary basis they block (AC-RUA-007: the reasons name the evidence).
// Without a ledger the rules are undecidable whatever the gates say, so only the missing evidence
// is named; the gates still report their own reasons (evidence/WP-14/decisions.md).

import type { GateValue, StructuredReason } from '../record-contract/primitives.ts';
import type { GateId } from '../record-contract/records/group-c/vocabulary.ts';

const SUBJECT = 'BR-RUA-005';

/** One input the basis needs: whether its file was given, whether it is usable, and where it should be. */
export interface MonetaryInput {
  readonly given: boolean;
  readonly present: boolean;
  readonly path: string;
}

export interface MonetaryInputs {
  readonly ledger: MonetaryInput;
  readonly payment: MonetaryInput;
  readonly decision: MonetaryInput;
}

export type MonetaryBasis =
  { readonly conclusive: true } | { readonly conclusive: false; readonly reasons: readonly StructuredReason[] };

const GATE_REASONS: readonly (readonly [GateId, string, string])[] = [
  ['independent_oracle', 'LEDGER_NOT_INDEPENDENT', 'the ledger snapshot is not proven independent (G1)'],
  ['ledger_access', 'LEDGER_INCOMPLETE', 'the ledger snapshot is not proven complete (G5)'],
  ['settlement', 'SETTLEMENT_NOT_ESTABLISHED', 'settlement is not established (G6)'],
];

/**
 * The D-15 monetary basis from the gate values and the inputs.
 *
 * @example
 * deriveMonetaryBasis(new Map([['independent_oracle', 'verified'], ['ledger_access', 'verified'],
 *   ['settlement', 'verified']]), inputs); // { conclusive: true } when every input is present
 */
export function deriveMonetaryBasis(gates: ReadonlyMap<GateId, GateValue>, inputs: MonetaryInputs): MonetaryBasis {
  const missing = [
    ...(inputs.ledger.present ? [] : [missingReason(ledgerCode(inputs.ledger), inputs.ledger.path, 'ledger snapshot')]),
    ...(inputs.payment.present ? [] : [missingReason('INPUT_MISSING', inputs.payment.path, 'payment')]),
    ...(inputs.decision.present ? [] : [missingReason('INPUT_MISSING', inputs.decision.path, 'approved decision')]),
  ];
  const gateReasons = inputs.ledger.present
    ? GATE_REASONS.filter(([gate]) => gates.get(gate) !== 'verified').map(([gate, code, detail]) => ({
        code,
        subject: SUBJECT,
        artifact_path: inputs.ledger.path,
        detail: `${detail}: the gate is ${gates.get(gate) ?? 'absent'}; expected verified`,
      }))
    : [];
  const reasons = [...gateReasons, ...missing];
  return reasons.length === 0 ? { conclusive: true } : { conclusive: false, reasons };
}

// A ledger file that was given but cannot be read is cited as evidence, so it is incomplete, not missing.
function ledgerCode(ledger: MonetaryInput): string {
  return ledger.given ? 'ARTIFACT_INCOMPLETE' : 'ARTIFACT_MISSING';
}

function missingReason(code: string, path: string, input: string): StructuredReason {
  return {
    code,
    subject: SUBJECT,
    artifact_path: path,
    detail: `${path} gives no usable ${input}; expected it for the monetary rules`,
  };
}
