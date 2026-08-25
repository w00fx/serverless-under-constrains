# Serverless Under Constraints

Serverless Under Constraints is an open lab that compares how AWS serverless architecture strategies preserve business invariants under failures and operating limits.

Each study deploys architecture variants into an AWS sandbox and gives them the same business scenario and controlled treatment. An independent oracle evaluates the evidence. The project publishes its protocol and evidence so another researcher can repeat the experiment and challenge its conclusions.

## Current work

Study 1 examines refund processing when a controlled provider commits a monetary effect but the caller reaches its deadline before receiving the response. The study plans to compare a conventional Lambda and SQS variant with a Lambda Durable Functions variant. Both variants run the `CONTROL` and `COMMIT_THEN_TIMEOUT` scenarios.

The oracle will use frozen provider-ledger evidence to check whether one approved refund request caused one authorized monetary effect without exceeding the captured payment amount.

## Repository status

The repository contains the project charter, the approved Study 1 specification, and the architecture decisions that constrain implementation. It does not contain runnable infrastructure or a trial runner yet.

## Start here

| Document | Purpose |
| --- | --- |
| [Project charter](PROJECT.md) | Defines the lab, its experimental cycle, milestones, and safety boundary. |
| [Study 1 specification](study-1/specs/refund-under-ambiguous-outcome.md) | Defines the refund domain, protocol, evidence model, oracle rules, and acceptance criteria. |
| [Architecture decisions](study-1/architecture/decisions/) | Records the design constraints adopted for Study 1. |

## Safety boundary

Experiments must target an allowlisted AWS sandbox account. Before provisioning resources, the runner must confirm the account, Region, and maximum run duration. Each deployment must include cleanup and a resource leak audit.
