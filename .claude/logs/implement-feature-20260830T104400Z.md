# Implement-feature run — 2026-08-30T10:44:00Z

- run id: RUN-issue-2-m0b-provider
- issue: w00fx/serverless-under-constrains#2
- typed branch: feature/2-controlled-provider
- mode: implement-feature / supervised-local/v1
- APPROVAL-FINGERPRINT: 885d2463e6485006b5f0969dcbf8b27dea9dcb65eba5edd77bc364bfe9ff5e65

## Phase 0 — Preflight

- Authority: `origin/main` = `379624bdbea0cb72ac5e779ba1105e57db7e787a` (T1 #20). Ticket pins spec @ `99814d14`. `git diff 99814d14 HEAD -- study-1/specs/refund-under-ambiguous-outcome.md` is empty. Pointed IDs/source/non-goals unchanged: `SPEC_REBASED_NO_RELEVANT_CHANGE`.
- Issue #2 open, unassigned, blocked-by #1 (closed). T3/T4 own caller transport and later treatment/release.
- Isolation: local `AGENTS.md` modification, untracked `.claude/logs/orchestrate-…` and `.claude/prompts/` are unowned and will not be mixed.
- Commands: root Makefile + `study-1` npm scripts.
- Node 24.15.0 via nvm.
- Baseline before work: `make check` exit 0 — 32/32 tests.
- Policy identity: `supervised-local/v1`.
- No semantic amendment proposed.

## Phase 1 — Proven delta

- expected: controlled refund provider + authoritative trial-scoped ledger + provider journals + authority boundary
- observed: T1 protocol-records only
- classification: implementation required

## Phase 2 — Ambiguities

Human accepted the recommended set: 1.1, 2.1, 3.1, 4.1, 5.1, 6 as written, 7.1.

## Phase 3 — Plan

- plan_sha256: `c03900ee05641d35f275a4ac273889df681024873e738a79a51d29f641caa09d`
- scope_manifest_sha256: `a8bf4b26bc7c4ffc5097d538857f09dea1d84463e1c4ed1556eeb1f4b5bab553`
- approved in session as `approved 885d2463e6485006b5f0969dcbf8b27dea9dcb65eba5edd77bc364bfe9ff5e65`

## Phase 4 — Owner implementation

- Node v24.15.0
- Module: `study-1/src/controlled-provider/`
- In-memory atomic store, typed IAM/table definitions, no CDK/SDK
- Commands extended: coverage, mutation, complexity, duplication, fuzz

## Phase 5 — Baseline deterministic verification

- `make check` — lint clean, tsc clean, 57/57 tests passed
- `make golden` — fixtures and tables passed
- `make coverage` — 100% line/branch/function/statement on protocol-records and controlled-provider
- `make complexity` — exit 0 (max 23)
- `make duplication` — 0 cross-file windows
- `make fuzz-study-1` — both seeded suites passed

## Phase 6 — Durable sync

- README.md and study-1/AGENTS.md document the provider module and command targets.
- No spec/table/oracle edits.

## Phase 7–10

Pending after Owner candidate commit.

## Mutation hardening — authoring pass

- role: mutation-hardener (`effort=max`), isolated worktree, no push
- input candidate: `64db7bdfd7ce266d868d09d33aa809bfc604b5e8`
- eligible target: `study-1/src/controlled-provider/**`
- Node v24.15.0 via nvm

First differential run on the eligible target: 510 mutants, 458 killed, 52 survived
(89.80%). Survivors fell into three classes, resolved as follows.

Unreachable guards removed, because no test could ever observe them:

- `bindingKeyOf` returned an optional key although `createRefundCall` rejects any
  call with zero or several bindings. It now returns the key, and the three
  redundant `key !== undefined` guards in `executionMatches`, `copyBinding`, and
  `journalEvent` are gone.
- `executionMatches` re-checked `active === undefined` after its only caller had
  already done so. It now takes a non-optional `ActiveExecution`, which makes the
  caller's guard load-bearing and observable.
- `readLedger` rejected a non-string cursor before a lookup that cannot match a
  non-string anyway. The lookup is now the only cursor validation; the
  non-string cursor test still asserts `invalid_cursor`.
- `InMemoryProviderStore.#prefixed` carried a private copy of the three-way
  `compareCodeUnits` comparator to sort by a single string key. It now sorts the
  keys with the default UTF-16 code-unit order, matching `serialize.ts` and
  `event-records.ts`. This also removed the last cross-file duplication window.

Behaviour that was implemented but never proven, now covered by tests:

- a refund bound to an execution instance other than the active one is rejected;
- a corrupted execution row that no longer names the trial reports
  `inactive_execution`, not the currency the payment disagrees on;
- CONTROL never consumes an armed treatment and never releases the barrier;
- every rejection is journalled with its own reasons, its event key, and a dense
  `source_sequence` across consecutive rejections;
- a failed reject transact reports `transact_failed`;
- ledger and journal rows are scoped to the trial that produced them, and are
  returned in transaction-id order whatever the write order;
- reads are denied with `inactive_execution` for a null execution, a mismatched
  binding value, and an unknown trial;
- reads work through a `variant_validation_id` binding;
- exact record shapes for `refund_transaction` and both `treatment_state` forms.

Second differential run: 479 mutants, 479 killed, 0 survived, 0 no-coverage,
0 errors, 0 timeouts — 100.00% on every file of the eligible target. No
equivalent or tooling-limited mutant had to be proposed.

Verification, all exit 0: `make check` (70 tests), `make golden`, `make coverage`
(100% line/branch/function/statement on both eligible trees), `make complexity`,
`make duplication` (0 cross-file windows), `make fuzz-study-1`, `make build`,
`make golden-mutation`, `make metrics`, `make security`, and
`npx stryker run --mutate 'src/controlled-provider/**/*.ts'`.

`make mutation-study-1` was not run: it also mutates `src/protocol-records`,
which this pass did not touch and was scoped out of the hardening loop.
No thresholds, exclusions, oracles, specs, or tables were changed.
