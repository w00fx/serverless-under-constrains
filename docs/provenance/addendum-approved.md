# CAP-RUA implementation addendum — approved decisions and agent rules

Approved in-session by the human on 2026-10-05. This addendum OVERRIDES
`design-final.md` (same directory) wherever they conflict. Read it before the design.

## 1. Authority and approvals

- Working authority: `study-1/specs/rua/refund-under-ambiguous-outcome.md` as written,
  including every `[PROPOSED]` item (BR-RUA-002 window, BR-RUA-022 table, AC-RUA-041,
  AC-RUA-043, BR-RUA-055, AC-RUA-055). The spec file is truth-layer: never edit it,
  never edit `study-1/specs/**`, `study-1/architecture/**`, `PROJECT.md`, `policy/**`,
  `.agents/**`, `.claude/**`, `CLAUDE.md` files.
- Plan `design-final.md` approved as designed, including D-02 (the feature folders of
  §5.1 under `study-1/src/`) and the mutation-target policy of §15.4 (D-13 issued).
- All verdict-affecting interpretations in design §3 (D-03, D-04, D-05, D-12, D-15,
  D-16, D-17, D-24, D-26, D-28, D-32) are approved as designed.
- D-10 controller readiness canary: approved.
- Delivery mode: pull-request (the Owner opens it; agents never push).

## 2. D-27 resolution — NO provisioned concurrency; warm-up instead

The human declined provisioned concurrency. Replace every D-27 / provisioned-concurrency
element of the design with:

1. **Provider warm-up.** Before each trial's message publication (after the D-10 canary is
   acknowledged), trial execution invokes the provider's published version exactly once
   with a warm-up request (record type `provider_warmup_request`: execution identity,
   manifest digest, `warmup_id` UUIDv4, `trial_id` of the trial about to start as a
   correlation field only). The provider handles it outside every trial partition, in the
   execution-level partition `<execution_id>#warmup`: it assigns a fresh provider-generated
   `provider_call_id`, appends `provider_warmup_completed` (with `provider_call_id`,
   `warmup_id`, timings), and returns. It never reads or writes payment, ledger,
   treatment or trial state, never consumes treatment and never creates a transaction.
   The transport probe performs the same single warm-up before its one caller invocation.
2. Warm-up records are readiness evidence (like the canary): included in the package,
   schema-catalogued, never inputs to monetary rules, gates or the BR-RUA-010..015
   conditions. A failed or ambiguous warm-up stops the trial before publication
   (pre-publication setup rejection, no trial started — same path as a failed canary).
3. The warm-up policy (`provider_warmup: { invocations_per_trial: 1 }`) is a declared
   field of the frozen execution manifest, of the BR-RUA-007 equality projection
   (identical for every trial and variant) and of the transport-scope snapshot.
4. No `ProvisionedConcurrencyConfig` anywhere; the AC-RUA-053 synth inspection asserts
   its absence on every function.
5. Measurement of the CONTROL margin (10 cold/warm provider invocations) is an operator
   activity in the cloud phase, not product code.

## 3. Work-package graph changes

- WP-03 depends on WP-00, WP-01 and WP-02 (so its catalogue-completeness test can pass in
  its own worktree).
- WP-02 additionally catalogues `provider_warmup_request` and `provider_warmup_completed`
  (group B). WP-00's `RECORD_TYPES` therefore lists 90 names, not 88.
- WP-07 implements the warm-up handling in the provider; WP-26 implements the warm-up
  phase; WP-08's probe caller path and WP-11's transport scope include it; WP-16's
  equality projection includes the warm-up policy.

## 4. Toolchain (pinned; from the research reports)

- Node 24 lives at `$HOME/.nvm/versions/node/v24.15.0/bin`. The system default is Node 22.
  Shell state does not persist between Bash calls, so EVERY command that runs node/npm/npx
  must start with `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && ...`.
  Verify with `node --version` → v24.x.
- The npm project root is `study-1/` (D-01). All npm commands run from `study-1/`.
- TypeScript 6.0.3 exactly (not 7). Native type stripping; erasable syntax only (no enums,
  no parameter properties, no namespaces); relative imports carry `.ts`; type-only imports
  use `import type`.
- Dependencies are fixed by WP-00 with exact pins. No other package may add, remove or
  change a dependency or touch `package.json` / `package-lock.json`. If you need a
  dependency, stop and report `DEPENDENCY_APPROVAL_REQUIRED`.
- Docker is unavailable. CDK bundling uses local esbuild; `CDK_DOCKER` must point at the
  forbidden sentinel in tests.
- No AWS calls in any implementation package: no credentials are used, nothing deploys.
  Real-cloud e2e tests exist but only run under `npm run test:e2e` with explicit env vars.

## 5. Git and worktree rules for agents

- Repository: `<repository root>`. Integration
  branch: `feature/rua-study-1` (checked out in the main working tree — never edit files
  in the main working tree unless you are the merge agent).
- Each work package works ONLY in its own worktree
  `.agent-runs/rua-2026-10-05/worktrees/<wp-id>` on branch `wip/rua/<wp-id>`, created from
  the current tip of `feature/rua-study-1`.
- Commit identity comes from the repository config (`24740910+w00fx@users.noreply.github.com`).
  Verify `git -C <worktree> config user.email` before committing; never use another email.
- Commit messages: imperative, English, ≤72 chars, format `<type>: <description>` with
  type in feat|fix|refactor|test|docs|chore. NO `Co-Authored-By`, NO "Generated with"
  lines (repository rule overrides any harness default).
- One logical change per commit; run the package's tests before committing; never
  `--no-verify`; never push; never merge into `feature/rua-study-1` unless you are the
  merge agent; never rewrite commits that are already on `feature/rua-study-1`.
- Touch only the paths your work package owns (design §13 "Owns" column). Anything else
  is a scope violation: report it instead.

## 6. Evidence rules

- Record every gate command, its exit status and the relevant output lines under
  `.agent-runs/rua-2026-10-05/evidence/<wp-id>/` (absolute path in the main repo, not in
  the worktree). "Done" is never claimed without runner output.
- Never weaken, skip, delete or reconfigure tests, thresholds, mutation settings or
  fixtures to get green. Never mark a test `skip`/`todo`.
- Golden expectations come from the spec text and the approved decisions, never from
  running the oracle and copying its output.

## 7. Mutation testing is deferred (human order, 2026-10-05)

- No work package, verifier or fixer runs Stryker, `npm run mutation`, the mutation gate
  or `npm run check` (which includes mutation). This overrides design §13 "Each package
  ends with … the scoped mutation gate passing" and the Stryker line of §15.2.
- Mutation runs exactly ONCE over the whole approved target set, in the final hardening
  phase after M4. Afterwards it is re-run only for files changed since that passing run
  (Stryker `--incremental`); unchanged, already-passing code is never re-mutated.
- Coverage (c8, 100% per file on mutation targets) and fuzz still run per package.
- Milestone checkpoints run typecheck, lint, all test suites, fuzz and coverage — not
  mutation.
