// The attribution inputs of one `billing import`, assembled from the frozen package (design §8.17;
// BR-RUA-047), and the reasons the result must stay `unverified` whatever the export says:
// - identity and the 12-digit account: the execution manifest's (`environment.account_id`);
// - resource identities: every physical id the frozen resource manifest records, and its stack id;
// - the window: the first mutation (runner journal) to the cleanup terminal instant (cleanup result
//   or the last recovery), widened to hours by `attributionWindow`;
// - the charge allowlist: the Owner-signed table (`billing-facts.ts`).
// A package with no first mutation or no terminal cleanup has no window, so it is refused. An empty
// allowlist, a manifest that proves no resource, or an export that attributes no line can only
// under-count, so each one demotes the check to `unverified` (BR-RUA-047: missing identities and
// incomplete exports produce `unverified`).

import type { AttributionContextInput } from '../billing-amendment/attribution-context.ts';
import { sortUnverifiedReasons, unverifiedReason } from '../billing-amendment/unverified-reasons.ts';
import type { UsageInterval } from '../billing-amendment/usage-window.ts';
import { attributionWindow } from '../billing-amendment/usage-window.ts';
import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { BillingImport, BillingUnverifiedReason } from '../record-contract/records/group-c/billing_import.ts';
import type { BillingFactTable } from './billing-facts.ts';
import type { PackageClosure } from './package-closure.ts';

/** The attribution inputs and the reasons that already make the import `unverified`. */
export interface BillingContext {
  readonly input: AttributionContextInput;
  /** `[floor_hour(first mutation), ceil_hour(cleanup terminal))`, as the import will state it. */
  readonly window: UsageInterval;
  readonly reasons: readonly BillingUnverifiedReason[];
}

/**
 * The attribution inputs of a finalized package, or why it has no attribution window.
 *
 * @example
 * const context = billingContextOf(admitted, closure, OWNER_SIGNED_BILLING_FACTS);
 * if (context.ok) buildBillingImport({ context: context.value.input, … });
 */
export function billingContextOf(
  admitted: AdmittedExecution,
  closure: PackageClosure,
  facts: BillingFactTable,
): Result<BillingContext, StructuredReason> {
  const { first_mutation_at: first, cleanup_terminal_at: terminal } = closure;
  if (first === undefined || terminal === undefined) {
    return err({
      code: 'BILLING_WINDOW_UNKNOWN',
      subject: 'BR-RUA-047',
      detail: `${admitted.package_directory} records first mutation ${String(first)} and cleanup terminal ${String(terminal)}; expected both, to bound the attribution window`,
    });
  }
  const manifest = closure.resource_manifest;
  const identities = [
    ...new Set([
      ...(manifest?.resources ?? []).flatMap((entry) => (entry.physical_id === undefined ? [] : [entry.physical_id])),
      ...(manifest?.stack_id === undefined ? [] : [manifest.stack_id]),
    ]),
  ];
  return ok({
    input: {
      identity: admitted.identity,
      account_id: admitted.manifest.environment.account_id,
      resource_identities: identities,
      charge_allowlist: facts.charge_allowlist,
      first_mutation_at: first,
      cleanup_terminal_at: terminal,
    },
    window: attributionWindow(first, terminal),
    reasons: [
      ...(facts.charge_allowlist.length === 0
        ? [
            unverifiedReason(
              'INCOMPLETE_ATTRIBUTION',
              `the Owner-signed charge allowlist is empty (${facts.provenance})`,
            ),
          ]
        : []),
      ...(identities.length === 0
        ? [unverifiedReason('INCOMPLETE_ATTRIBUTION', 'the frozen resource manifest proves no resource identity')]
        : []),
    ],
  });
}

/**
 * The record with its check demoted to `unverified` when `reasons` is not empty, or when no line
 * was attributed; unchanged otherwise.
 *
 * @example
 * demotedBillingImport(record, []).billed_cost_check; // 'unverified' when record.lines_used is empty
 */
export function demotedBillingImport(
  record: BillingImport,
  reasons: readonly BillingUnverifiedReason[],
): BillingImport {
  const unattributed =
    record.lines_used.length === 0
      ? [unverifiedReason('INCOMPLETE_ATTRIBUTION', 'the export attributes no line to the execution')]
      : [];
  const [first, ...rest] = sortUnverifiedReasons([...record.reasons, ...reasons, ...unattributed]);
  if (first === undefined) {
    return record;
  }
  const { attributed_total_usd: _total, ...base } = record as BillingImport & {
    readonly attributed_total_usd?: string;
  };
  return { ...base, billed_cost_check: 'unverified', reasons: [first, ...rest] };
}
