# Freeze trial results and assess late evidence separately

Each trial's core evidence and oracle result become immutable before DLQ deletion or infrastructure cleanup. Correlated evidence arriving afterward is preserved in a separate late-evidence stream and never rewrites the frozen verdict, but contradictions can make the run ineligible for comparison or publication; this keeps the audit trail honest without allowing results to drift after observation.
