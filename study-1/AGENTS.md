Study 1 is governed by @specs/refund-under-ambiguous-outcome.md and the decisions under @architecture/decisions/.

Before proposing or implementing work:

- read the complete specification and applicable architecture decisions;
- follow the M0 through M4 delivery sequence;
- implement only the current delivery task and its required evidence;
- keep all Study 1 implementation under this directory;
- treat the sandbox account and coordination identity as operator inputs, not open design questions;
- perform no AWS mutation until the specification's admission and safety gates permit it.

`src/protocol-records/` is the local M0-A contract surface: create, reject, serialize, hash, and verify deterministic protocol records. It performs no cloud mutation.

`src/controlled-provider/` is the local M0-B provider and ledger surface: accept or reject refund calls, persist an in-memory authoritative ledger and provider journals, and enforce the variant/independent authority boundary. It performs no cloud mutation.

`src/coordination/` is the M0-C operator baseline: a separate CDK entry point plus bootstrap, read-only verify, and guarded destroy. Experimental code may only verify and use the frozen identity and schema. Commands require an injected cloud adapter; they do not bind live AWS.

`src/evidence-packages/` is the local M0-C original-package surface: write-once evidence and package indexes, prefix checkpoints, and read-only original-package verification with no selected amendment. It performs no cloud mutation and does not write eligibility into an original package.

## Commands

From `study-1/`, Node.js 24:

- `npm run lint`
- `npm run typecheck`
- `npm test` — `node --experimental-strip-types --test`
- `npm run check` — lint, typecheck, and tests
- `npm run golden` — locked canonical-byte fixtures
- `npm run golden-tables` — `specs/tables/` reference rows
- `npm run fuzz` — seeded invalid-input properties
- `npm run coverage` — line and branch coverage for `src/protocol-records`, `src/controlled-provider`, `src/coordination`, and `src/evidence-packages`
- `npm run mutation` — Stryker on `src/protocol-records`, `src/controlled-provider`, `src/coordination`, and `src/evidence-packages`
- `npm run coordination:bootstrap` / `coordination:verify` / `coordination:destroy` — operator baseline commands (injected adapter only)

Root `make check`, `make golden`, `make mutation-study-1`, and `make fuzz-study-1` wrap these. See the repository `AGENTS.md` Commands table.
