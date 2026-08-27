# Serverless Under Constraints

Status: Project charter v0.2
Date: August 27, 2026
First deliverable: Study 1, refunds under ambiguous outcomes

Primary specification: [Study 1: Evaluate Refund-Invariant Preservation Under Ambiguous Outcomes](study-1/specs/refund-under-ambiguous-outcome.md)

This charter states the lab's purpose, vocabulary, safety posture, and Study 1 delivery sequence. Protocol rules, acceptance criteria, numeric fixtures, and milestone gates live only in the specification and the Study 1 architecture decisions.

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

Study 1 adds protocol terms that this charter does not redefine: transport qualification, coordination lease, settlement, evidence freeze, amendment, package eligibility, cleanup, and leak audit. Their definitions live in the specification.

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

The protocol requires a journal of each phase transition. When a phase fails, available evidence is preserved, the trial is classified, and cleanup runs.

Study 1 places a blocking transport qualification before citable study runs, holds a coordination lease around experimental mutation, requires settlement before evidence freeze, and treats late evidence and billing as immutable amendments. Those rules are specified, not restated here.

## Study 1 Scope

The approved vertical PoC is two variants (conventional Lambda and SQS, and Lambda durable functions), two scenarios (`CONTROL` and `COMMIT_THEN_TIMEOUT`), one fixed full-refund decision, a controlled provider, an independent oracle, immutable evidence, cleanup, and leak audit.

The specification lists the PoC non-goals. They include a third variant, a second treatment, an agentic decision lane, a generic plugin system or multi-study runner, and a parent-level shared library.

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

This is the target Study 1 architecture. It is not a claim that these components already exist in the repository.

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

## Technical Baseline

The specification freezes these choices:

- Application language: TypeScript.
- Runtime: Node.js 24. Other major versions are out of scope.
- Infrastructure as code: AWS CDK v2.
- Package manager: npm with a committed lockfile.
- Region: `us-east-1`. Admission rejects any other Region.
- Environment: an allowlisted AWS sandbox account with no production credentials.
- Money: integers in the currency's minor unit. BRL values use cents.
- Time and identifiers: UTC, UUIDs, and ISO 8601 timestamps.

The lockfile owns exact dependency versions. Live AWS work still requires operator-supplied account and coordination identity; those inputs are not unspecified protocol decisions.

## Repository Layout

Current layout:

```text
.
├── AGENTS.md
├── PROJECT.md
├── README.md
└── study-1/
    ├── AGENTS.md
    ├── package.json
    ├── package-lock.json
    ├── tsconfig.json
    ├── eslint.config.js
    ├── specs/
    │   └── refund-under-ambiguous-outcome.md
    ├── architecture/
    │   └── decisions/
    ├── src/
    │   ├── probe-admission/
    │   └── coordination/
    └── test/
```

Later Study 1 implementation stays under `study-1/`. The repository does not have a top-level `specs/`, `studies/`, or `packages/runner` tree.

## Operational Safety

Before provisioning resources, execution must:

- require an explicit allowlisted sandbox account ID;
- require Region `us-east-1`;
- require a maximum run duration;
- reject resources without the required study and run tags;
- record the commit and tool versions;
- show the resource plan and spending cap when available.

Every deployment needs idempotent cleanup in a construct equivalent to `finally`. The leak audit searches for resources by run tags. The project does not run against production or move real money.

Baseline coordination is operator-managed infrastructure, not a run-owned resource. Probes and runs may verify and use its frozen identity; they do not bootstrap, migrate, or destroy it as part of trial cleanup.

## Delivery Sequence

Study 1 uses the specification's M0 through M4 sequence. Checkpoint names below are labels only; completion criteria remain in the specification.

- **M0** — protocol foundation and treatment-transport qualification, with internal checkpoints M0-A through M0-D.
- **M1** — offline oracle and canonical study contracts from immutable synthetic evidence.
- **M2** — conventional variant vertical validation.
- **M3** — Durable variant vertical validation.
- **M4** — canonical four-cell study run.

This charter does not mark any milestone complete. Current code status belongs in [README.md](README.md).

## Operator Inputs Versus Open Questions

The specification's Open Questions section is `None`. Remaining live-AWS values are operator-supplied deployment inputs, including the allowlisted 12-digit sandbox account ID and the coordination resource identity. They do not reopen protocol or design questions.

## Initial Technical Sources

- [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started.html)
- [Retries for Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html)
- [Durable functions or Step Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-step-functions.html)
- [Testing serverless functions and applications](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html)

## Instruction for Agents

Read this file and the Study 1 specification before proposing code. Follow the specification's current milestone. Do not implement later milestones to prepare for future work. Do not treat operator-supplied account or coordination values as unresolved specification questions.
