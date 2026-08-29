# Serverless Under Constraints

Serverless Under Constraints is an open lab that compares how AWS serverless architecture strategies preserve business invariants under failures and operating limits.

Each study deploys architecture variants into an AWS sandbox and gives them the same business scenario and controlled treatment. An independent oracle evaluates frozen evidence. The project publishes its protocol and evidence so another researcher can repeat the experiment and challenge its conclusions.

## Current work

Study 1 examines refund processing when a controlled provider commits a monetary effect but the caller reaches its deadline before receiving the response. The approved vertical PoC compares a conventional Lambda and SQS variant with a Lambda Durable Functions variant under `CONTROL` and `COMMIT_THEN_TIMEOUT`.

The oracle will use frozen provider-ledger evidence to check whether one approved refund request caused one authorized monetary effect without exceeding the captured payment amount.

Protocol rules, fixtures, acceptance criteria, and delivery gates live in the [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md). The [project charter](PROJECT.md) defines the lab boundary and delivery sequence.

## Repository status

The initial commit contains:

- the project charter and repository guidance;
- the Study 1 specification and architecture decisions.

No application code, package manifest, lockfile, test suite, infrastructure definition, or deployed AWS resource exists yet. Delivery starts with Milestone 0 and follows the sequence in the specification.

## Start here

| Document | Purpose |
| --- | --- |
| [Project charter](PROJECT.md) | Lab purpose, vocabulary, safety posture, and Study 1 delivery sequence. |
| [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md) | Refund domain, protocol, evidence model, oracle rules, and acceptance criteria. |
| [Architecture decisions](study-1/architecture/decisions/) | Design constraints adopted for Study 1. |
| [Study 1 guidance](study-1/AGENTS.md) | Scope and sequencing rules for Study 1 work. |

## Safety boundary

Experiments must target an allowlisted AWS sandbox account. Admission rejects any Region other than `us-east-1`. Execution must confirm the account, Region, spending ceiling, and maximum duration before provisioning resources. Each deployment must include cleanup and a resource leak audit. The project does not run against production or move real money.
