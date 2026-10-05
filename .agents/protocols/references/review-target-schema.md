# Exact candidate, handoff and Owner acceptance contract

This is the sole schema reference for the two authoring roles. The implementation
lives in the existing `scripts/spec-anchored` CLI. All artifacts stay under one
`.agent-runs/<run-id>/` directory; use fresh names for every round.

## Identity and trust boundary

Artifact references are `{ "path": "relative/path", "sha256": "<digest>" }`.
Their digest covers exact bytes. Paths are relative to the chain's directory;
absolute paths, traversal and symlinks are refused. Reports never execute their
`command` strings during verification.

Internal links `target_sha256`, `handoff_sha256`, scope/policy/approval hashes use
`sa-canon/1` canonical JSON. Plan/task/amendment hashes use canonical text. The
chain itself is referenced by its exact-byte digest. Never relabel a report with
another SHA. Use `canonicalize` rather than inventing a hashing convention.

Local verification checks files, Git objects, complete diffs and cross-artifact
identity. It does NOT authenticate human/forge events, validate a model's internal
configuration, prove that a tool's report is truthful, or substitute for semantic
Owner inspection. A trusted launcher captures runtime receipts; the pipeline or
human authenticates approval evidence and checks required remote events.

## Approved hardening configuration

Add this `hardening` object to the existing scope manifest BEFORE computing the
approval fingerprint. It is required for authoring handoffs, not for unrelated
legacy scope checks:

```json
{
  "mutation_targets": ["src/payments/calculate.ts"],
  "test_paths": ["tests/payments/**"],
  "non_executable_paths": ["docs/payments.md"],
  "budget_seconds": 600,
  "allow_equivalent_disposition": false
}
```

Targets and non-executable exemptions are exact paths; test locations may use the
supported patterns. The values above are illustrative repository choices, not
universal paths or budgets. They are bound by `scope_manifest_sha256` in approval.
Changing them is a new approval. Final mutation eligibility includes added/moved
production logic; only preapproved non-executable paths and real test paths are
excluded. Owner/external review must reject misclassification as a test or document.

## Build a target

```bash
python3 scripts/spec-anchored build-hardening-target \
  --run-id RUN-123 --role general-code-reviewer \
  --base <approved-base-sha> --candidate <owner-checkpoint-sha> \
  --scope <scope.json> --policy <issued-policy.json> \
  --approval-bundle <approval-bundle.json> \
  --owner-model <model-observed-by-launcher> \
  --repo <repository> --output <run-dir>/general-target.json
```

The writer refuses to overwrite an artifact. It derives `input_tree_sha` and
`diff_sha256` from Git and binds `run_id`, `role`, `base_sha`,
`input_candidate_sha`, `scope_manifest_sha256`, `policy_sha256`,
`approval_fingerprint`, `owner_model`, `required_effort: max`, and
`schema_version: 1`. The target never pins a model globally; its runtime identity
is the Owner model observed for this run.

## Handoff envelope — both roles

Required fields (closed schema version 1):

```text
schema_version: 1
run_id
role: general-code-reviewer | mutation-hardener
target_sha256: canonical target hash
input_candidate_sha
output_commit_sha
output_tree_sha
status
changed_paths: sorted exact paths
changes: [{path, summary, reason}] — exactly one explanation per changed path
behavioral_impact: nonempty explanation, including preserved behavior
verification: [executed verification records]
runtime_record: artifact reference
remaining_risks: [strings]
owner_review_required: true
mutation: mutation-only payload; absent for General
```

If no code changed, output equals input. Otherwise output must be one non-merge
commit whose only parent is the pinned input. Both roles can author production and
tests within scope, but neither can edit truth/oracles even when the Owner holds a
supervised amendment grant. A commit is a proposal, not an approval.

Completed authoring statuses are `CODE_HARDENED | NO_CHANGES_NEEDED` for General;
`MUTATION_HARDENED | MUTATION_NOT_APPLICABLE | MUTANT_DISPOSITION_REQUIRED` for
Mutation. Semantic, scope, dependency, tooling and oracle blockers do not enter a
completed hardening chain. No-change corroboration remains a separate
non-authoring path; the two-stage changed-candidate verifier does not prove that
no semantic gap exists.

### Verification record

```text
command: exact executed command
exit_code: 0
result: pass
candidate_sha: exact commit on which the check ran
artifact: reference to nonempty raw output
```

Run checks after making the handoff commit and before returning it; transient
outputs are not committed. Further edits require a new commit and fresh evidence.
Owner reruns have the same format and refer to the integrated candidate.

### Runtime receipt

```text
schema_version: 1
run_id
role
input_candidate_sha
owner_model
requested_model
effective_model
requested_effort: max
effective_effort: max
evidence: raw launcher/session metadata reference
```

The launcher, not model introspection, supplies these observations. All three
model identities must agree. Unknown metadata or downgrade blocks. Worktree/cwd,
credential isolation and actual agent discovery must be qualified in the runtime;
a parsed prompt or receipt alone does not establish these properties.

## Mutation payload

```text
eligible_target: exact final production paths
coverage: [{path, lines_total, lines_covered, branches_total, branches_covered}]
mutants: [{id, path, status, property, killed_by: [test names], evidence: ref}]
tool: {name, version, config: artifact reference}
not_applicable_reason: null, or a reason when no eligible target exists
```

For eligible files, line counts must be positive and all lines/branches covered.
Zero branches is N/A, not fictitious branch execution. Each mutant belongs to the
final target and has its own ID, property and evidence. States:

| State | Effect |
|---|---|
| `KILLED` | A named relevant test detected a valid mutant |
| `SURVIVED` / `NO_COVERAGE` | Blocks completion |
| `INVALID_MUTANT` | Visible outside the valid denominator; never kill credit |
| `TOOL_ERROR` | Blocks; not an equivalent or a kill |
| `EQUIVALENT_CANDIDATE` | Pending until an authorized human disposition |

At least one valid mutation site is required for measured sensitivity. An
all-invalid/empty population never means 100%. Raw kill rate and resolution rate
are different: an accepted equivalence resolves a case without becoming KILLED.
A mutation-induced timeout can be a kill only when a named, bounded test actually
reported that failure; a runner-wide unexplained timeout is a tool error.

N/A requires no eligible files, no mutants/coverage, no authoring delta and an
explicit reason. It carries null metrics, not 100%. Tool availability alone is
never evidence of a completed fuzzing or mutation campaign.

## Owner disposition

Required fields (closed schema version 1):

```text
schema_version: 1
run_id
role
handoff_sha256: canonical handoff hash
decision: ACCEPT_ALL | REJECT | PARTIAL
integrated_commit_sha
accepted_paths: []
rejected_paths: []
rationale: nonempty
verification: [Owner rerun records]
equivalent_dispositions: []
```

Owner reruns belong in `verification`. Accepted/rejected path sets must be disjoint
and cover the complete delta. For hunk-level partial acceptance, keep the edited
path in `accepted_paths` and explain rejected hunks in `rationale`; it still
requires new hardening and cannot reuse a complete-handoff report.

`ACCEPT_ALL` adopts the exact output commit by fast-forward from the input.
`REJECT` retains the exact input commit. `PARTIAL`, cherry-pick, conflict resolution
or any other recreated commit requires a new checkpoint and both passes, even
when a cherry-pick happens to have an identical tree. No evidence is silently
transferred by changing metadata. A valid partial/rejected disposition is NOT a
successful completed chain.

An equivalent decision entry contains `mutant_id`,
`decision: equivalent_accepted`, `authority`, `reason`, and `evidence` reference.
Only a supervised run with `allow_equivalent_disposition: true` can use it; the
human decision is recorded before delivery. Other modes stop and request upstream
disposition. The original agent report remains pending; the verified Owner
disposition resolves it without pretending the agent approved its own exclusion.

## Verify and deliver

```bash
python3 scripts/spec-anchored verify-handoff \
  --target <general-target.json> --handoff <general-handoff.json> \
  --scope <scope.json> --policy <policy.json> \
  --approval-bundle <approval-bundle.json> --artifacts-root <run-dir> \
  --disposition <general-owner-disposition.json> --repo <repository>
```

`hardening-chain.json` is a single envelope referencing existing artifacts:

```text
schema_version: 1
run_id, task_ref, base_sha, head_sha
scope, policy, approval_bundle, approval_record: artifact references
plan, task: references to the approved text
spec_corpus: reference to {"specs/...": "exact-byte sha256", ...}
semantic_amendment: optional approved amendment text reference
steps: [
  {target, handoff, disposition},  # general-code-reviewer references
  {target, handoff, disposition}   # mutation-hardener references
]
final_evidence: reference to {schema_version: 1, run_id, head_sha, checks: [...]}
```

The spec inventory is verified against the actual Git revision in the approval.
The second target must start at the first accepted output; final HEAD must be the
accepted Mutation output. All refs are read and their bytes hashed.

```bash
python3 scripts/spec-anchored verify-chain <run-dir>/hardening-chain.json --repo <repository>
python3 scripts/spec-anchored verify-result <run-dir>/result.json \
  --chain <run-dir>/hardening-chain.json --repo <repository>
```

New result schema v2 common fields are `schema_version`, `run_id`, `task_ref`,
`adapter`, `execution_mode`, `delivery_mode`, `terminal`, `claim_state`.
`LOCAL_CHANGE_READY` and `PR_READY_AWAITING_HUMAN` additionally require `base_sha`,
`head_sha`, `approval_fingerprint`, `hardening_chain_sha256`. Only the PR result
adds `pr_url`; only PR delivery parks the claim. Local delivery releases it.

Local task identity is `local:<repository-id>#<task-id>` and uses a local approval
provider; remote task identity remains `owner/repo#N`. Local delivery is supported
only by `implement-feature` in supervised mode. `NAMED_BLOCKER` adds
`blocker_kind`, `reason`, `evidence` refs without inventing a remote comment.
`NO_CHANGE_REQUIRED` adds `classification`, `corroborated: true`,
`evidence_target_sha256`, `no_change_corroboration_sha256`.

`validate-result` retains legacy schema-v1 shape support for stored artifacts;
it is not a successful-delivery verifier. `verify-result` requires v2 and a real
changed-candidate chain, checks current HEAD and rejects dirty/untracked work.
Remote PR existence, human authenticity and external-review completion remain
separate forge/pipeline checks. No local command claims those events happened.
