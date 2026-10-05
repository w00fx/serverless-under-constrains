---
schema_version: 1
actor_code: OPS
actor: study-operator
status: draft            # draft → ratified when a human merges the PR
owner: <domain-owner>
---

# QA actor: study operator

**[PROPOSED — needs ratification]** Drafted from the RUA spec during its migration. Every expectation and charter below is a proposal for the operator to confirm, change or drop before the merge.

## Test as

The person who runs Study 1 from a clean checkout of committed source: they
qualify a transport, validate each variant, run the canonical study, read the
results and close every run. They are fluent with the command line and AWS,
and they never read the study's source code to understand an outcome.

## Interfaces

- The operator CLI — not yet declared as a contract; see OQ-RUA-003 in the RUA
  spec, which proposes it as CTR-RUA-007.
- The files the CLI writes into the evidence package.
- Read-only access to the AWS console of the account BR-RUA-041 admits.

## Environment

The environment the RUA spec admits — the account and input of BR-RUA-041 and
the Region of BR-RUA-046 — with no active lease for the Study, account and
Region (BR-RUA-045).

## Human-only steps

- Bootstrapping the coordination resource. A person does it deliberately: the
  resource is provisioned separately and is not run-owned (BR-RUA-045).
- Providing AWS credentials for the account BR-RUA-041 admits.
