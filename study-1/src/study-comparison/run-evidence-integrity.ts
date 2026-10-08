// The run-level `evidence_integrity_status` (CTR-RUA-002; design §8.14 condition 6, "which re-checks
// INV-RUA-001 across all four trials"). Each oracle result already judged its own trial: its G8
// `evidence_integrity` gate and its INV-RUA-001 `identity_integrity`. Identities are unique within
// their complete execution scope (INV-RUA-001), so the run also re-checks that no provider
// transaction id appears in two trials: a duplicate provider-generated identity makes evidence
// integrity `invalid`. Precedence is `invalid > unverified > verified`, and a missing result is
// `unverified`.

import type { StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { ApplicableGateValue } from '../record-contract/records/group-c/vocabulary.ts';
import type { GateValue } from '../record-contract/primitives.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { comparisonReason } from './comparison-reasons.ts';
import type { FrozenRecord } from './record-files.ts';

/** The oracle results of a run's declared trials, by trial id; a trial without one is absent. */
export type OracleResultsByTrial = ReadonlyMap<Uuid4, FrozenRecord<OracleResult>>;

/** `verified` with no reason, or a lower value with the reasons for it. */
export type RunEvidenceIntegrity =
  | { readonly status: 'verified'; readonly reasons: readonly [] }
  | {
      readonly status: Exclude<ApplicableGateValue, 'verified'>;
      readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
    };

interface Finding {
  readonly value: Exclude<ApplicableGateValue, 'verified'>;
  readonly reason: StructuredReason;
}

/**
 * Derives the run-level evidence integrity from the four oracle results.
 *
 * @example
 * deriveRunEvidenceIntegrity(manifest.trials, results); // { status: 'verified', reasons: [] }
 */
export function deriveRunEvidenceIntegrity(
  trials: readonly DeclaredTrial[],
  results: OracleResultsByTrial,
): RunEvidenceIntegrity {
  const findings = [
    ...trials.flatMap((trial) => trialFindings(trial, results.get(trial.trial_id))),
    ...crossTrialFindings(trials, results),
  ];
  const [first, ...rest] = findings.map((finding) => finding.reason);
  if (first === undefined) {
    return { status: 'verified', reasons: [] };
  }
  return {
    status: findings.some((finding) => finding.value === 'invalid') ? 'invalid' : 'unverified',
    reasons: [first, ...rest],
  };
}

/**
 * The oracle-result path of a declared trial (design §7 `derived/oracle-result.json`).
 *
 * @example
 * oracleResultPath(trialId); // 'trials/<trialId>/derived/oracle-result.json'
 */
export function oracleResultPath(trialId: Uuid4): string {
  return PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, 'oracleResult');
}

/**
 * The reason a declared trial has no oracle result; every condition that needs the result repeats
 * this one reason, so the union lists it once.
 *
 * @example
 * missingOracleResultReason(trialId).code; // 'ORACLE_RESULT_MISSING'
 */
export function missingOracleResultReason(trialId: Uuid4): StructuredReason {
  const path = oracleResultPath(trialId);
  return comparisonReason(
    'ORACLE_RESULT_MISSING',
    trialId,
    `${path} is absent; expected the frozen oracle result of trial ${trialId}`,
    path,
  );
}

function trialFindings(trial: DeclaredTrial, result: FrozenRecord<OracleResult> | undefined): readonly Finding[] {
  const path = oracleResultPath(trial.trial_id);
  if (result === undefined) {
    return [{ value: 'unverified', reason: missingOracleResultReason(trial.trial_id) }];
  }
  // The schema fixes the nine gates in GATE_IDS order; G8 `evidence_integrity` is the ninth.
  const gate = result.record.validity_gates[8].value;
  return [
    ...gateFinding(trial, path, 'evidence_integrity gate', gate),
    ...gateFinding(trial, path, 'identity_integrity', result.record.identity_integrity),
  ];
}

function gateFinding(trial: DeclaredTrial, path: string, name: string, value: GateValue): readonly Finding[] {
  if (value === 'verified') {
    return [];
  }
  const detail = `trial ${trial.trial_id} has ${name} ${value}; expected verified`;
  return [
    {
      value: value === 'invalid' ? 'invalid' : 'unverified',
      reason: comparisonReason('EVIDENCE_INTEGRITY_NOT_VERIFIED', trial.trial_id, detail, path),
    },
  ];
}

function crossTrialFindings(trials: readonly DeclaredTrial[], results: OracleResultsByTrial): readonly Finding[] {
  const owners = new Map<string, Uuid4[]>();
  for (const trial of trials) {
    const ids = new Set(results.get(trial.trial_id)?.record.monetary_observations.provider_transaction_ids ?? []);
    ids.forEach((id) => {
      owners.set(id, [...(owners.get(id) ?? []), trial.trial_id]);
    });
  }
  return [...owners.entries()]
    .filter(([, trialIds]) => trialIds.length > 1)
    .map(([transactionId, trialIds]) => ({
      value: 'invalid',
      reason: comparisonReason(
        'CROSS_TRIAL_IDENTITY_REUSE',
        transactionId,
        `provider_transaction_id ${transactionId} is reported by trials ${trialIds.join(', ')}; expected each provider transaction id in one trial only (INV-RUA-001)`,
      ),
    }));
}
