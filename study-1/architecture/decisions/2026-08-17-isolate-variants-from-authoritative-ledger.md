# Isolate variants from the authoritative provider ledger

PoC variants may invoke refunds but cannot query the authoritative provider ledger or a provider-status endpoint; only the independent oracle has read access. Reconciliation and compensation are excluded so an ambiguous first attempt remains unknown to the variant, allowing the study to measure each execution strategy's configured retry behavior rather than an added recovery mechanism.
