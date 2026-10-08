---
schema_version: 1
actor: study-operator
area: interruption-and-recovery
crosses: [CAP-RUA]
tags: [aws, human-step]
status: draft            # draft → ratified when a human merges the PR
owner: <domain-owner>
---

# QA: interruption and recovery — study operator

**[PROPOSED — needs ratification]** Drafted from the RUA spec during its migration. Every expectation and charter below is a proposal for the operator to confirm, change or drop before the merge.

## Setup

A probe, validation or study run is in progress, or has just ended with
incomplete closure.

## Expectations

### QA-OPS-009 — An interrupted run never leaves the operator guessing

After an operator abort, a lost lease or the safety deadline, the operator can
tell which resources were cleaned, which remain, and whether the evidence is
still usable.

### QA-OPS-010 — Operational recovery never touches the evidence

When cleanup, the leak audit or the lease closure did not finish, the operator
can complete it through the CLI and see the effective status change, while the
original results stay exactly as they were.

### QA-OPS-011 — A refused start says what blocks it

When the CLI refuses to start — an active lease, a breached safety limit, a
stale qualification — it says what blocks and how to clear it.

## Charters

- Explore interruptions at different moments — during provisioning, mid-trial,
  during cleanup — looking for a state the operator cannot interpret or recover
  from.
- Explore expired credentials and network loss mid-run, looking for failures
  the CLI does not report.

## Out of scope

The lease and safety rules themselves, BR-RUA-045 and BR-RUA-046, verified by
their acceptance criteria.

## Report

For each expectation: pass, fail or blocked, with what was done and what was
observed. For each charter: what was tried. For each finding: what happened,
what was expected, and the steps to reproduce it.
