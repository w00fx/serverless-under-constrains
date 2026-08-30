To read about this project, read @PROJECT.md

## Commands

From the repository root. Node.js 24. `make bootstrap` once per clone.

| Command | Purpose |
| --- | --- |
| `make check` | Whole-repo lint, typecheck, and tests |
| `make check-study-1` | Same, scoped to Study 1 |
| `make golden` | Locked-byte fixtures plus `study-1/specs/tables/` |
| `make golden-mutation` | Sabotage one table row and require `golden-tables` to fail |
| `make mutation-study-1` | Stryker on `study-1/src/protocol-records` |
| `make fuzz-study-1` | Seeded property cases for protocol-record validation |
| `make coverage` | Line and branch coverage for the Study 1 eligible target |
| `make complexity` | ESLint complexity on the eligible target (max 23; current peak) |
| `make duplication` | Cross-file token-window duplication on the eligible target |
| `make secrets` | gitleaks (blocking; incident-class) |
| `make security` | `npm audit --audit-level=high` |
| `make build` | TypeScript compile check (`tsc --noEmit`) |
| `make metrics` | Ratchet: lint, audit, and coverage may not worsen |
| `make check-e2e` | N/A — no UI |
| `make race` | N/A — no Go race detector |

Study 1 still owns the npm scripts under `study-1/` (`npm run check`, `npm run golden`, `npm run mutation`). The Makefile is the harness contract.
