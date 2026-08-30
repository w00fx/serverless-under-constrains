import type { Principal, ProviderOperation } from "./types.ts";

export const PROVIDER_TABLES = [
  {
    name: "provider_ledger",
    partition_key: "trial_id",
    sort_key: "provider_transaction_id",
    consistent_read: true,
  },
  {
    name: "provider_journal",
    partition_key: "trial_id",
    sort_key: "event_id",
    consistent_read: true,
  },
  {
    name: "treatment_state",
    partition_key: "trial_id",
    sort_key: "state",
    consistent_read: true,
  },
  {
    name: "trial_payments",
    partition_key: "trial_id",
    sort_key: "payment_id",
    consistent_read: true,
  },
  {
    name: "active_execution",
    partition_key: "trial_id",
    sort_key: "execution",
    consistent_read: true,
  },
] as const;

export const AUTHORIZATION: Record<
  Principal,
  { allow: readonly ProviderOperation[]; deny: readonly string[] }
> = {
  variant: {
    allow: ["refund"],
    deny: ["read_ledger", "read_treatment_state", "provider_status"],
  },
  independent: {
    allow: ["refund", "read_ledger", "read_treatment_state"],
    deny: ["provider_status"],
  },
};
