## Summary

<!-- What changed and why. -->

## Harness notes (when this PR is prep or touches gates)

- Found:
- Added:
- Deferred:
- Baseline: see `.metrics-baseline.json`

### Class completeness

| Class | Instance | Status |
| --- | --- | --- |
| Lint + typecheck | ESLint + `tsc --noEmit` | |
| Tests + coverage | `node:test` + c8 | |
| Mutation testing | Stryker `@stryker-mutator/core` | |
| Property/fuzz | seeded `node:test` | |
| Complexity / duplication | ESLint complexity + token-window script | |
| Race detection | N/A (TypeScript) | |
| Secrets | gitleaks 8.30.1 | |
| Security analysis | `npm audit` | |
| Build | `tsc --noEmit` | |
| E2E / browser | N/A (no UI) | |

## Test plan

- [ ] `make check`
- [ ] `make golden`
- [ ] Other applicable `make` targets for the changed surface
