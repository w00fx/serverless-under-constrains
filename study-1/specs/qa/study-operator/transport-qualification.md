---
schema_version: 1
actor: study-operator
area: transport-qualification
crosses: [CAP-RUA]
tags: [smoke, aws, human-step]
status: draft            # draft → ratified when a human merges the PR
owner: <domain-owner>
---

# QA: transport qualification — study operator

**[PROPOSED — needs ratification]** Drafted from the RUA spec during its migration. Every expectation and charter below is a proposal for the operator to confirm, change or drop before the merge.

## Setup

The coordination resource is bootstrapped (a human-only step). The environment
admission input is in place. No transport probe is selected yet.

## Expectations

### QA-OPS-001 — The operator can qualify a transport on their own

Following only what the CLI shows — its help, its output and the files it
writes — the operator can admit a probe, run it, verify its package and select
it, with no step they have to guess.

### QA-OPS-002 — The probe outcome and the next step are unmistakable

After a probe run, the operator can tell whether the transport passed, failed or
is indeterminate, why, and what to do next: select it, discard it, or run a new
probe.

### QA-OPS-003 — A probe run always ends closed

Whatever the verdict, the operator can confirm that cleanup succeeded, the leak
audit is clean and the lease is released — or is told exactly what remains and
how to finish it.

## Charters

- Explore admission with realistic mistakes — a dirty checkout, the wrong
  account, a missing or edited environment input — looking for a rejection that
  does not say what to fix.
- Explore probe selection — an indeterminate probe, two passing probes, a probe
  qualified against older source — looking for a selection the operator cannot
  understand or undo.

## Out of scope

Whether the transport conditions are derived correctly. That is verified by
AC-RUA-002, AC-RUA-021, AC-RUA-031 and AC-RUA-032.

## Report

For each expectation: pass, fail or blocked, with what was done and what was
observed. For each charter: what was tried. For each finding: what happened,
what was expected, and the steps to reproduce it.
