---
schema_version: 1
actor: study-operator
area: variant-validation
crosses: [CAP-RUA]
tags: [aws, release]
status: draft            # draft → ratified when a human merges the PR
owner: <domain-owner>
---

# QA: variant validation — study operator

**[PROPOSED — needs ratification]** Drafted from the RUA spec during its migration. Every expectation and charter below is a proposal for the operator to confirm, change or drop before the merge.

## Setup

A qualified transport probe is selected.

## Expectations

### QA-OPS-004 — A variant validation reads as one result

After validating one variant, the operator can tell its implementation
validation status — verified, failed or indeterminate — and why, from the
output and the summary alone.

### QA-OPS-005 — A validation never passes for a study

Nothing the validation prints or writes invites the operator to compare
variants or to treat it as the canonical study.

## Charters

- Explore validations that end indeterminate through an operational problem
  mid-run, looking for an outcome the operator cannot act on.
- Explore starting a validation against an unselected or drifted probe, looking
  for a refusal that does not explain why.

## Out of scope

How the validation status is derived. That is verified by AC-RUA-025,
AC-RUA-035 and AC-RUA-036.

## Report

For each expectation: pass, fail or blocked, with what was done and what was
observed. For each charter: what was tried. For each finding: what happened,
what was expected, and the steps to reproduce it.
