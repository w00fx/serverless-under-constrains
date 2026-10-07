# Serverless Under Constraints

Serverless Under Constraints is an open lab that compares how AWS serverless architecture strategies preserve business invariants under failures and operating limits.

Each study deploys architecture variants into an AWS sandbox and gives them the same business scenario and controlled treatment. An independent oracle evaluates frozen evidence. The project publishes its protocol and evidence so another researcher can repeat the experiment and challenge its conclusions.

## Current work

Study 1 examines refund processing when a controlled provider commits a monetary effect but the caller reaches its deadline before receiving the response. The approved vertical PoC compares a conventional Lambda and SQS variant with a Lambda Durable Functions variant under `CONTROL` and `COMMIT_THEN_TIMEOUT`.

The oracle will use frozen provider-ledger evidence to check whether one approved refund request caused one authorized monetary effect without exceeding the captured payment amount.

Protocol rules, fixtures, acceptance criteria, and delivery gates live in the [Study 1 specification](study-1/specs/rua/refund-under-ambiguous-outcome.md). The [project charter](PROJECT.md) defines the lab boundary and delivery sequence.

## Repository status

Study 1 is implemented under [`study-1/`](study-1/): the controlled provider, both caller variants, the CDK infrastructure, the evidence model and oracle, and the `rua` operator CLI that admits, executes, cleans up and verifies each execution. It has unit, contract, integration, golden and fuzz suites, run locally through `npm run check`. The coverage gate requires 100% line, branch, function and statement coverage for every file except the AWS and Node bindings, the Lambda handlers, the CLI entry point and the infrastructure code. Mutation testing has not run yet.

The first sandbox study ran on 2026-10-07 in `us-east-1`. It covered one transport probe, a variant validation for each variant, and one run of four trials. The run verified as complete and comparison-eligible: every trial was valid, cleanup succeeded and the leak audit was clean. Both variants passed `CONTROL` with one refund. Under `COMMIT_THEN_TIMEOUT`, each variant created two provider transactions, refunding 20000 for an approved 10000, so both failed the preservation verdict. This is the result the specification predicts when the provider has no idempotency key.

The study's AWS resources were removed after the run. Evidence packages stay local under `study-1/evidence/`, which git ignores. The specification is still a draft, and its `[PROPOSED]` items are not ratified.

## Start here

| Document | Purpose |
| --- | --- |
| [Project charter](PROJECT.md) | Lab purpose, vocabulary, safety posture, and Study 1 delivery sequence. |
| [Study 1 specification](study-1/specs/rua/refund-under-ambiguous-outcome.md) | Refund domain, protocol, evidence model, oracle rules, and acceptance criteria. |
| [Architecture decisions](study-1/architecture/decisions/) | Design constraints adopted for Study 1. |
| [Study 1 guidance](study-1/CLAUDE.md) | Scope and sequencing rules for Study 1 work. |

## Safety boundary

Experiments must target an allowlisted AWS sandbox account. Admission rejects any Region other than `us-east-1`. Execution must confirm the account, Region, spending ceiling, and maximum duration before provisioning resources. Each deployment must include cleanup and a resource leak audit. The project does not run against production or move real money.
