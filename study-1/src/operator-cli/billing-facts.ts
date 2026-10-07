// The Owner-signed billing facts `billing import` attributes lines with (design §8.17, §17 U-10;
// BR-RUA-047): which run-owned product/operation pairs may be charged to an execution. They are
// facts about AWS's CUR 2.0 output, not code, so they come from the Owner with a cited source; until
// the cloud phase sources them (U-10, decision 73) the table is empty, and an empty table makes
// every import `unverified` (`billing-context.ts`), never `within_limit`.

import type { ChargeAllowlistEntry } from '../billing-amendment/attribution-context.ts';

/** The signed table: its entries and where they were sourced. */
export interface BillingFactTable {
  readonly charge_allowlist: readonly ChargeAllowlistEntry[];
  /** The cited source and the Owner's signature, or why the table is still empty. */
  readonly provenance: string;
}

/** The facts in force. Changing an entry needs a cited source and the Owner's signature. */
export const OWNER_SIGNED_BILLING_FACTS: BillingFactTable = {
  charge_allowlist: [],
  provenance: 'U-10 unsourced (decision 73): the cloud phase sources the CUR 2.0 product/operation pairs',
};
