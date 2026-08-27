# Serverless Under Constraints

Serverless Under Constraints is an open lab that compares how AWS serverless architecture strategies preserve business invariants under failures and operating limits.

Each study deploys architecture variants into an AWS sandbox and gives them the same business scenario and controlled treatment. An independent oracle evaluates the evidence. The project publishes its protocol and evidence so another researcher can repeat the experiment and challenge its conclusions.

## Current work

Study 1 examines refund processing when a controlled provider commits a monetary effect but the caller reaches its deadline before receiving the response. The approved vertical PoC compares a conventional Lambda and SQS variant with a Lambda Durable Functions variant under `CONTROL` and `COMMIT_THEN_TIMEOUT`.

The oracle will use frozen provider-ledger evidence to check whether one approved refund request caused one authorized monetary effect without exceeding the captured payment amount.

Protocol, fixtures, acceptance criteria, and delivery gates are in the [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md). The [project charter](PROJECT.md) does not replace that document.

## Repository status

This branch contains:

- the project charter, Study 1 specification, and architecture decisions;
- a Node.js 24 TypeScript project at `study-1/` with a committed lockfile;
- local probe admission and freeze (merged from PR #52);
- operator coordination commands and CDK synthesis for the baseline lease table (Issue #11 / PR #53).

It does not yet contain a trial runner, variants, a canonical four-cell run, or real-AWS qualification. No live AWS setup or mutation has been performed.

## Local commands

From `study-1/`, on Node.js 24:

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | built-in Node test runner |
| `npm run check` | lint, typecheck, and tests |
| `npm run coordination:bootstrap` | operator-only baseline deploy entry |
| `npm run coordination:verify` | read-only identity and schema check entry |
| `npm run coordination:destroy` | guarded baseline destroy entry |

`npm run check` is the declared local gate. The coordination scripts are CLI entry points; on this branch they do not bind a live AWS adapter and they do not mutate cloud resources.

## Start here

| Document | Purpose |
| --- | --- |
| [Project charter](PROJECT.md) | Lab purpose, vocabulary, safety posture, and Study 1 delivery sequence. |
| [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md) | Refund domain, protocol, evidence model, oracle rules, and acceptance criteria. |
| [Architecture decisions](study-1/architecture/decisions/) | Design constraints adopted for Study 1. |
| [Study 1 commands](study-1/AGENTS.md) | Local toolchain notes for the `study-1/` project. |

## Safety boundary

Experiments must target an allowlisted AWS sandbox account. Admission rejects any Region other than `us-east-1`. Before provisioning resources, execution must confirm the account, Region, and maximum run duration. Each deployment must include cleanup and a resource leak audit. The project does not run against production or move real money.
