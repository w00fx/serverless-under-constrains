Study 1 is governed by @specs/refund-under-ambiguous-outcome.md and the decisions under @architecture/decisions/.

Before proposing or implementing work:

- read the complete specification and applicable architecture decisions;
- follow the M0 through M4 delivery sequence;
- implement only the current delivery task and its required evidence;
- keep all Study 1 implementation under this directory;
- treat the sandbox account and coordination identity as operator inputs, not open design questions;
- perform no AWS mutation until the specification's admission and safety gates permit it.

`src/protocol-records/` is the local M0-A contract surface: create, reject, serialize, hash, and verify deterministic protocol records. It performs no cloud mutation.

## Commands

From `study-1/`, Node.js 24:

- `npm run lint`
- `npm run typecheck`
- `npm test` — `node --experimental-strip-types --test`
- `npm run check` — lint, typecheck, and tests
- `npm run golden` — locked canonical-byte fixtures
- `npm run coverage` — line and branch coverage for `src/protocol-records`
- `npm run mutation` — Stryker on `src/protocol-records`
