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
- Install and build: Node `>=24.12.0 <25` and npm 11, then `npm ci`. There is no build
  step: Node runs the TypeScript sources directly.
- Fast loop: `npm run typecheck && npm run lint && npm run test:unit`.
- Golden: `npm run test:golden` (it also checks the generated fixtures).
- Full gate: `npm run check` (typecheck, lint, all suites, `FC_RUNS=10000` fuzz, 100%
  coverage, mutation).
- Operator CLI: `npm run rua -- <command>` (`node src/operator-cli/main.ts`). It prints one
  `cli_result` JSON line. The exit codes are 0 completed, 2 usage error, 3 admission
  rejected, 4 execution incomplete, 5 verification failed, 6 operational closure not
  clean, 7 lease problem, 10 internal failure.

## Before anything touches the cloud

Real-cloud commands mutate an AWS account and spend money. Tests, local emulation
and synthesis may run from a dirty tree, but only clean committed source produces
citable evidence (BR-RUA-042), and every run stays within the safety limits
(BR-RUA-046). Never start a real-cloud run as an experiment: it creates evidence
and cost.