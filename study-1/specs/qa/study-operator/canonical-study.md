---
schema_version: 1
actor: study-operator
area: canonical-study
crosses: [CAP-RUA]
tags: [aws, release]
status: draft            # draft → ratified when a human merges the PR
owner: <domain-owner>
---

# QA: canonical study — study operator

**[PROPOSED — needs ratification]** Drafted from the RUA spec during its migration. Every expectation and charter below is a proposal for the operator to confirm, change or drop before the merge.

## Setup

A qualified transport probe is selected.

## Expectations

### QA-OPS-006 — The operator can run the four-cell study end to end

From a clean checkout and a selected probe, the operator can run the canonical
study and receive its summary without any manual step the CLI does not
describe.

### QA-OPS-007 — The summary answers what the study found

From the summary alone, the operator can read each trial verdict, whether the
study may be compared and why, and how the run closed: cleanup, leak audit and
lease.

### QA-OPS-008 — Someone else can check the result

The operator can hand the package to another person, who verifies it with the
documented command and reaches the same package eligibility.

## Charters

- Explore a study whose treatment results contradict the hypothesis, looking
  for any output that hides, reorders or softens them.
- Explore re-running after a change to unrelated reporting code, looking for a
  demand to re-qualify the transport that should not exist.

## Out of scope

Whether the preservation verdicts are correct. That is the oracle's job,
verified by the capability's acceptance criteria.

## Report

For each expectation: pass, fail or blocked, with what was done and what was
observed. For each charter: what was tried. For each finding: what happened,
what was expected, and the steps to reproduce it.
