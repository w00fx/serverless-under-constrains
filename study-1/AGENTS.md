This project is based on @specs/refund-under-ambiguous-outcome.md

## Commands

From `study-1/`, Node.js 24:

- `npm run lint`
- `npm run typecheck`
- `npm test` — `node --experimental-strip-types --test`
- `npm run check` — lint, typecheck, and tests

The three coordination scripts are operator-only entry points and are not imported by probe/run code. They keep separate bootstrap, verify, and destroy semantics. In this PR they have no live `CoordinationCloud` adapter: the CLI main path exits without cloud mutation. Live binding and real operator invocation belong to T22 / Issue #22.

- `npm run coordination:bootstrap` — intended operator-only baseline deploy; adapter-less entry in this PR, pending T22
- `npm run coordination:verify` — intended read-only identity/schema check of the frozen lease table; adapter-less entry in this PR, pending T22
- `npm run coordination:destroy` — intended guarded baseline destroy (exact account, Region, stack ID, confirmation, verified ready baseline, and no blocking leases); adapter-less entry in this PR, pending T22
