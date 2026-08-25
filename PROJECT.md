# Serverless Under Constraints

Status: Project charter v0.1
Date: August 17, 2026
First deliverable: Study 1, refunds under ambiguous outcomes

Primary specification: [Study 1: Refunds Under Ambiguous Outcomes](specs/refund-under-ambiguous-outcome/refund-under-ambiguous-outcome.md)

## Purpose

Serverless Under Constraints is an open lab for comparative studies. Each study deploys real AWS Serverless architectures, subjects them to the same business scenario and controlled treatment, and measures whether they preserve a business invariant.

The lab publishes its protocol, infrastructure, source code, raw data, telemetry, costs, oracle results, and limitations. Another person should be able to deploy the environment, repeat the experiment, and challenge the conclusion using the evidence.

## Guiding Question

How do different AWS Serverless architecture strategies preserve business invariants under failures, traffic spikes, cost limits, concurrency, or consistency requirements?

## Positioning

The project supports two modes through the same experimental cycle:

1. **Validation:** run the protocol against one architecture and check the invariant.
2. **Comparison:** run the protocol against two or more variants and compare business damage, recovery, latency, and cost.

The project starts as a lab. A reusable runner may follow after different studies reveal which parts of the cycle remain stable. The first version does not promise a general-purpose end-to-end testing platform.

## Principles

1. **Real AWS environments:** primary experiments run on resources deployed to a sandbox account. Emulators may support local development, but they do not produce the final evidence.
2. **Business invariants:** each study measures money, orders, inventory, or another customer-visible effect. Uptime and error counts remain diagnostic signals.
3. **Controlled treatments:** each run declares the constraint, its causal point, and the affected population.
4. **Independent oracles:** the verdict does not rely only on state or telemetry produced by the system under test.
5. **Fair comparisons:** variants receive the same inputs, treatment, and observation window.
6. **Evidence before narrative:** raw data and the protocol support the article, video, and presentation.
7. **Earned scope:** the PoC proves one vertical slice. New variants, treatments, and abstractions wait until that slice works.

## Project Language

**Study:** a published investigation with a question, protocol, variants, results, and limitations.
_Avoid:_ demo, generic benchmark.

**Variant:** a complete architecture strategy subjected to the protocol.
_Avoid:_ winner, competitor.

**Treatment:** the controlled condition applied during a run. It may be a failure, workload, limit, or change.
_Avoid:_ fault injection as the generic term, because not every study uses chaos engineering.

**Invariant:** a business rule that the system must preserve during and after the treatment.
_Avoid:_ infrastructure metric, technical SLA.

**Oracle:** the component that queries independent evidence and returns `pass`, `fail`, or `indeterminate`.
_Avoid:_ monitor.

**Trial:** one repetition of a variant under a declared treatment and seed.
_Avoid:_ test when the scope is ambiguous.

**Runner:** the local coordinator for the experimental cycle.
_Avoid:_ platform, simulator.

## Experimental Cycle

```text
preflight
  -> provision
  -> seed/reset
  -> baseline
  -> workload
  -> treatment
  -> observe
  -> oracle
  -> preserve evidence
  -> cleanup
  -> leak audit
```

The runner records each phase transition in a journal. When a phase fails, the runner preserves the available evidence, classifies the trial, and runs cleanup.

## Initial Core Boundary

Shared code may handle:

- run, variant, scenario, trial, and seed identities;
- account, Region, budget, and duration preflight checks;
- phase ordering and journaling;
- command execution with timeouts and cancellation;
- resource and artifact manifests;
- common observation and oracle-result formats;
- idempotent cleanup and resource leak auditing.

Each study remains responsible for:

- variant infrastructure;
- test data and workload;
- treatment implementation;
- controlled external dependencies;
- oracle logic;
- telemetry queries and cost calculations.

Study 1 must not introduce an invariant DSL, plugin system, web interface, hosted control plane, automatic account discovery, or multi-cloud support.

## Architecture of the First Vertical Slice

```text
Experiment definition
        |
        v
Local runner ----------------------------------+
  |         |             |                    |
  v         v             v                    v
Variant   Workload   Treatment controller   Evidence collector
  |                         |                    |
  +------> AWS stack ------>+--------------------+
                |
                v
      Controlled refund provider
                |
                v
       Independent provider ledger
                |
                v
              Oracle
```

The refund provider simulates a controlled external dependency. The variants use real AWS services for functions, queues, tables, and orchestration.

## Initial Technical Decisions for the PoC

- Application and runner language: TypeScript.
- Target runtime: Node.js 24, subject to confirmation during bootstrap.
- Infrastructure as code: AWS CDK v2.
- Package manager: npm with a versioned lockfile.
- Initial Region: `us-east-1`, configurable and subject to service availability.
- Environment: an allowlisted AWS sandbox account with no production credentials.
- Money: integers in the currency's minor unit. BRL values use cents.
- Time and identifiers: UTC, UUIDs, and ISO 8601 timestamps.

The lockfile owns exact dependency versions. The project must verify runtime and Region support before the first deployment.

## Initial Repository Structure

```text
.
├── PROJECT.md
├── README.md
├── specs/
│   └── refund-under-ambiguous-outcome/
│       └── refund-under-ambiguous-outcome.md
├── studies/
│   └── 01-refund-under-ambiguous-outcome/
│       ├── experiment.yaml
│       ├── infrastructure/
│       ├── scenarios/
│       ├── variants/
│       └── README.md
├── packages/
│   └── runner/
└── runs/                    # ignored by Git; stores local artifacts
```

This tree describes the PoC target. Bootstrap should create only the directories that receive code in the current increment.

## Operational Safety

Before provisioning resources, the runner must:

- require an explicit allowlisted sandbox account ID;
- confirm the Region;
- require a maximum run duration;
- reject resources without study and run tags;
- record the commit and tool versions;
- show the resource plan and spending cap when available.

Every deployment needs idempotent cleanup in a construct equivalent to `finally`. The leak audit searches for resources by run tags. The project does not run against production or move real money.

## Deliverables

### Milestone 0: Documentation and Skeleton

- versioned charter and specification;
- initialized repository;
- local validation commands;
- no deployed infrastructure.

### Milestone 1: Vertical PoC

- a controlled refund dependency with an independent ledger;
- the `COMMIT_THEN_TIMEOUT` treatment;
- a conventional Lambda and SQS variant;
- a Lambda durable functions variant;
- a reproducible minimal workload;
- an executable oracle;
- an evidence package for at least one trial per variant.

### Milestone 2: Repeatable Protocol

- trial count and seeds fixed before collection;
- randomized variant order;
- verified reset and cleanup;
- one command derives raw data and the summary;
- recorded limitations and threats to validity.

### Milestone 3: Complete Study 1

- a third variant selected and implemented;
- a second treatment selected and implemented;
- an agentic lane added without mixing model variability into architecture recovery measurements;
- cost per correct completion calculated;
- canonical study published in English and Portuguese.

## PoC Definition of Done

The PoC is complete when a person can use the repository to:

1. validate the account and tools;
2. deploy both variants and the controlled provider;
3. run the normal case;
4. run `COMMIT_THEN_TIMEOUT` with the same data;
5. receive an oracle result tied to the ledger;
6. inspect the artifacts supporting that result;
7. remove the resources and confirm that the leak audit passed.

A screenshot or trace without a manifest, oracle result, and raw data does not complete the PoC.

## Open Questions Before the First Deployment

1. Which sandbox account ID may the runner use?
2. What spending cap and maximum duration apply to each run?
3. How many trials and which seeds make up the publishable collection?
4. Which delay will cause a timeout in each variant without changing the commit point?
5. Will the study compare complete architecture recipes or separate architecture and idempotency through a factorial design?
6. Which third variant will enter the full study, and how will AgentCore participate without becoming a confounding variable?
7. What name will the fictional marketplace use?

## Initial Technical Sources

- [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started.html)
- [Retries for Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html)
- [Durable functions or Step Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-step-functions.html)
- [Testing serverless functions and applications](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html)
- [Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)

## Instruction for Codex CLI

Read this file and the Study 1 specification before proposing code. Start with Milestone 0. Do not implement later milestones to prepare for future work. Stop and surface any open decision that changes observable behavior, safety, cost, or experimental validity before writing code.
