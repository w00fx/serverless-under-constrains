# study-1 — refund-invariant preservation under ambiguous outcomes (CAP-RUA)

Claude Code loads this file when it works in this folder. It holds what is local
to this capability's code; what must be true lives in its spec.

## Truth for this capability

- Spec: `specs/rua/refund-under-ambiguous-outcome.md` (CAP-RUA). Only `ratified` text is authority;
  `[PROPOSED]` text is not.
- QA: the areas under `specs/qa/study-operator/` whose `crosses` includes CAP-RUA.
- To implement it whole: `/implement-feature study-1/specs/rua/refund-under-ambiguous-outcome.md`.

## Working here

- The stack is normative for this study (BR-RUA-053).
- Install and build: <fill in>
- Fast loop: <the check-study-1 command that /prep declared>
- Golden: <fill in>
- Operator CLI: not declared yet (OQ-RUA-003).

## Before anything touches the cloud

Real-cloud commands mutate an AWS account and spend money. Tests, local emulation
and synthesis may run from a dirty tree, but only clean committed source produces
citable evidence (BR-RUA-042), and every run stays within the safety limits
(BR-RUA-046). Never start a real-cloud run as an experiment: it creates evidence
and cost.