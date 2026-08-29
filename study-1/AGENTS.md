This project is based on @../specs/refund-under-ambiguous-outcome.md

## Commands

From `study-1/`, Node.js 24:

- `npm run lint`
- `npm run typecheck`
- `npm test` — `node --experimental-strip-types --test`
- `npm run check` — lint, typecheck, and tests

`src/protocol-records/` is the local M0-A contract surface: create, reject, serialize, hash, and verify deterministic protocol records. It performs no cloud mutation.
