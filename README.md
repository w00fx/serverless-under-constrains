# Serverless Under Constraints

Serverless Under Constraints is an open lab that compares how AWS serverless architecture strategies preserve business invariants under failures and operating limits.

Each study deploys architecture variants into an AWS sandbox and gives them the same business scenario and controlled treatment. An independent oracle evaluates frozen evidence. The project publishes its protocol and evidence so another researcher can repeat the experiment and challenge its conclusions.

## Current work

Study 1 examines refund processing when a controlled provider commits a monetary effect but the caller reaches its deadline before receiving the response. The approved vertical PoC compares a conventional Lambda and SQS variant with a Lambda Durable Functions variant under `CONTROL` and `COMMIT_THEN_TIMEOUT`.

The oracle will use frozen provider-ledger evidence to check whether one approved refund request caused one authorized monetary effect without exceeding the captured payment amount.

Protocol rules, fixtures, acceptance criteria, and delivery gates live in the [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md). The [project charter](PROJECT.md) defines the lab boundary and delivery sequence.

## Repository status

This branch contains:

- the project charter, Study 1 specification, and architecture decisions;
- a Node.js 24 TypeScript project at `study-1/` with a committed lockfile;
- local M0-A protocol records that create, reject, serialize, hash, and verify deterministic contracts;
- a local controlled refund provider and in-memory authoritative ledger;
- a local shared caller that journals dispatch, timeout, and effect knowledge;
- an operator-managed coordination baseline (separate CDK entry, verify, and guarded destroy);
- local original evidence-package finalization and independent verification.

It does not contain variants, transport qualification, an oracle, amendment chains, or any live AWS mutation. Experimental paths cannot provision or destroy the coordination baseline.

## Local commands

From the repository root, after `make bootstrap` (Node.js 24):

| Command | Purpose |
| --- | --- |
| `make check` | Lint, typecheck, and tests |
| `make check-study-1` | Same, scoped to Study 1 |
| `make golden` | Locked fixtures and spec tables |
| `make golden-mutation` | Sabotage one table row and require the table harness to fail |
| `make mutation-study-1` | Stryker on protocol records, the controlled provider, coordination, evidence packages, and the caller |
| `make fuzz-study-1` | Seeded invalid-input properties |
| `make complexity` | ESLint complexity on the eligible target |
| `make duplication` | Cross-file token-window duplication |
| `make secrets` | gitleaks (blocking) |
| `make security` | `npm audit --audit-level=high` |
| `make build` | TypeScript compile check |
| `make metrics` | Lint / audit / coverage ratchet |
| `make check-e2e` | N/A — no UI |
| `make race` | N/A — no Go race detector |

From `study-1/`, on Node.js 24:

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | built-in Node test runner |
| `npm run check` | lint, typecheck, and tests |
| `npm run golden` | locked canonical-byte fixtures |
| `npm run golden-tables` | `specs/tables/` reference rows |
| `npm run fuzz` | seeded invalid-input properties |
| `npm run coverage` | line and branch coverage for protocol records, the controlled provider, coordination, evidence packages, and the caller |
| `npm run mutation` | Stryker on protocol records, the controlled provider, coordination, evidence packages, and the caller |
| `npm run coordination:bootstrap` | operator bootstrap (injected cloud adapter; no live AWS bind) |
| `npm run coordination:verify` | read-only frozen-identity verify |
| `npm run coordination:destroy` | guarded destroy; refuses blocking or unverifiable leases |

`npm run check` is the declared local gate.

## Start here

| Document | Purpose |
| --- | --- |
| [Project charter](PROJECT.md) | Lab purpose, vocabulary, safety posture, and Study 1 delivery sequence. |
| [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md) | Refund domain, protocol, evidence model, oracle rules, and acceptance criteria. |
| [Architecture decisions](study-1/architecture/decisions/) | Design constraints adopted for Study 1. |
| [Study 1 guidance](study-1/AGENTS.md) | Scope and sequencing rules for Study 1 work. |

## Safety boundary

Experiments must target an allowlisted AWS sandbox account. Admission rejects any Region other than `us-east-1`. Execution must confirm the account, Region, spending ceiling, and maximum duration before provisioning resources. Each deployment must include cleanup and a resource leak audit. The project does not run against production or move real money.
