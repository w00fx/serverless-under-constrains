# CAP-RUA decisions log

Every decision taken during the CAP-RUA implementation run. From 2026-10-05 (M0 close-out) on, by
human order, the Owner takes the recommended option without asking and records it here. Each
entry gives who decided, what, why and where it is applied. Full texts live in
`design/addendum-approved.md` (human approvals at plan time) and `design/amendments-owner.md` (A-xx).

| # | Date | Decided by | Decision | Reason | Applied in |
|---|---|---|---|---|---|
| 1 | 2026-10-05 | human | Draft spec incl. every [PROPOSED] item is the working authority | plan approval | addendum §1 |
| 2 | 2026-10-05 | human | Plan approved as designed; all verdict-affecting interpretations approved; D-10 canary | plan approval | addendum §1 |
| 3 | 2026-10-05 | human | No provisioned concurrency; one provider warm-up per trial; 10 cold/warm measurements are operator activity | cost and simplicity | addendum §2 |
| 4 | 2026-10-05 | human | Mutation testing runs once at the end; re-run only for changed files | run time | addendum §7 |
| 100 | 2026-10-07 | Owner | Delivered: docs commits `fd26225` (study-1/CLAUDE.md placeholders: install, fast loop, golden, full gate, operator CLI and its real exit-code table) and `9a8f08a` (README repository status), lint exit 0; branch pushed with the w00fx account; PR #1 https://github.com/w00fx/serverless-under-constrains/pull/1 opened against `main`, body = pr-body.md (results, step-by-step walkthrough, all 56 ACs with citing suites and real-cloud observations, defects fixed, teardown, open items, QA areas), no attribution lines (user rule), sandbox account id redacted (repo is PUBLIC). State: PR_READY_AWAITING_HUMAN. Never merged | pr-body.md | delivery |
| 101 | 2026-10-07 | human (recorded by Owner) | Deviation recorded: commit `fd26225` (decision 100) edited `study-1/CLAUDE.md` although addendum §1 forbids agents to edit `CLAUDE.md` files. `git show --stat fd26225` lists only `study-1/CLAUDE.md` (10 insertions, 4 deletions): it touched no oracle, evidence, golden or spec path. It also dropped the OQ-RUA-003 pointer, which `761fa83` restored on the human's explicit order the same day | `git show --stat fd26225` | record accuracy |
