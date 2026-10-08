---
schema_version: 1
capability_id: CAP-RUA
status: ratified     # draft → ratified when a human merges the spec PR
owner: <domain-owner>
approved_by: Raphael Moura
approved_at: 2026-10-07
provenance: Migrated from Study 1 Specification v1.0 to the typed-ID template. This revision approves the six items that had the [PROPOSED] mark (BR-RUA-002, the BR-RUA-022 transition table, AC-RUA-041, AC-RUA-043, AC-RUA-055 and BR-RUA-055) as the code at 9ce4ad7 does them. Items marked "Added in this revision" make existing text explicit. This revision closes OQ-RUA-001 and OQ-RUA-002.
---

# Capability: Study 1 — Evaluate refund-invariant preservation under ambiguous outcomes

Approved vertical PoC scope: two variants, two scenarios, one fixed full-refund decision, controlled provider, independent oracle, immutable evidence, cleanup, and leak audit.

## Purpose

This capability evaluates what happens when a controlled refund provider commits a monetary effect but the caller never observes the response. The caller may interpret the missing response as a failure and retry, creating more than one monetary effect for one approved logical request.

The experiment succeeds when it executes the declared protocol, captures sufficient independent evidence, and derives the correct `pass`, `fail`, or `indeterminate` preservation verdict. A variant may violate a refund invariant; that is a valid experimental result rather than project failure.

## Research Question

When the provider commits a refund before the caller times out, how does each declared execution strategy preserve the approved refund invariants under its configured retry path?

## Initial Hypothesis

Checkpointing and resumption can reduce repeated internal work after failure, but they do not resolve an external monetary effect whose outcome remains ambiguous. Both treatment variants are expected to create two successful transactions under the configured retry paths. The oracle must derive the observed result exclusively from frozen evidence and must not encode this expectation as a verdict.

## PoC Boundary

The complete vertical PoC includes:

- a conventional variant;
- a Durable variant;
- untreated `CONTROL` trials;
- `COMMIT_THEN_TIMEOUT` treatment trials;
- a controlled refund provider and authoritative ledger;
- a blocking pre-study transport qualification;
- a sequential four-trial runner;
- an independent oracle;
- immutable evidence packages and amendments;
- normal and emergency cleanup;
- a leak audit;
- operational safety checks and later attributable-cost amendments.

## Capability Language

**Payment**: The one trial-scoped record of a captured BRL amount that bounds its associated successful refunds.  
_Avoid_: Order, charge, balance.

**Approved decision**: The fixed resolved authorization for one full refund.  
_Avoid_: Agent response, model output.

**Refund request**: The stable logical intent to return the approved amount from one payment.  
_Avoid_: Attempt, provider call, transaction.

**Attempt**: One physical variant attempt to perform the logical refund request.  
_Avoid_: Refund request.

**Provider request**: One intended outbound request created by an attempt.  
_Avoid_: Provider call.

**Provider call**: One physical request received by the controlled provider, including a rejected call.  
_Avoid_: Attempt, provider request.

**Refund transaction**: One immutable `SUCCEEDED` monetary effect committed to the provider ledger.  
_Avoid_: Response, attempt, completed execution.

**Provider ledger**: The authoritative trial-scoped source of successful refund transactions.  
_Avoid_: Variant state, journal, log, trace.

**Attempt journal**: The durable evidence of caller attempts, outcomes, dispatch, processing, and knowledge state.  
_Avoid_: Provider ledger.

**Ambiguous outcome**: A dispatched call for which the variant lacks an authoritative response proving whether a monetary effect occurred.  
_Avoid_: Authoritative rejection, simple local failure.

**`COMMIT_THEN_TIMEOUT` treatment**: The controlled condition in which the first accepted provider call commits, the caller's application deadline wins, and the response is released only after the timeout is durably observed.  
_Avoid_: Generic timeout, fixed sleep.

**Variant**: A complete execution strategy subjected to the declared protocol.  
_Avoid_: An isolated service.

**Scenario**: Either `CONTROL` or `COMMIT_THEN_TIMEOUT`.

**Run attempt**: The admission lifecycle that begins when a proposed run identifier is generated and ends in rejection or promotion to a canonical run.

**Run**: One runner invocation against one immutable four-trial run manifest.

**Trial**: One isolated execution of one variant under one scenario.

**Seed**: A declared input for deterministic choices controlled by the runner. It does not control cloud runtime variance.

**Transport probe**: A pre-study real-cloud qualification of the selected treatment transport.  
_Avoid_: Study trial, preservation result.

**Variant validation**: An immutable two-trial, one-variant implementation validation that cannot support cross-variant comparison.  
_Avoid_: Canonical run, partial comparison.

**Oracle**: The independent evaluator that derives trial results from frozen protocol inputs and authoritative evidence.  
_Avoid_: Dashboard, alarm, variant completion state.

**Preservation verdict**: The lowercase machine result `pass`, `fail`, or `indeterminate` for one trial.

**Correct completion**: A derived result that is true only when preservation passes and request processing terminates with `SUCCEEDED`.

**Settlement**: The jointly established absence of active processing, provider work, barriers, queue activity, and incomplete ledger evidence after the declared stabilization interval.  
_Avoid_: A single empty-queue counter, handler return.

**Late evidence**: Correlated evidence appearing after a result's evidence freeze. It is assessed separately and never mutates the frozen result.

**Package eligibility**: A verifier-derived judgment that one original package and explicitly selected amendment chain are structurally and cryptographically usable.  
_Avoid_: Preservation success, implementation success, comparison eligibility.

## Financial Domain

### BR-RUA-016 — Trial financial composition

Each trial contains exactly:

- one payment;
- one approved full-refund request;
- an initially empty trial-scoped provider ledger.

The provider ledger stores only immutable `SUCCEEDED` transactions. Timed-out, failed, and rejected calls belong to journals rather than the ledger.

Partial refunds, multiple logical requests, pending or failed provider transactions, reversals, chargebacks, reconciliation, compensation, and provider-side idempotency are outside the PoC.

## Business Rules

The rules in this section are protocol-defined for Study 1 version 1. They are not derived from an external regulatory source.

### BR-RUA-001 — One Effect per Request

When a valid isolated trial settles, the provider ledger must contain exactly one successful transaction associated with its declared `refund_request_id`.

```text
count(successful_transactions where refund_request_id = R) = 1
```

### BR-RUA-002 — Payment Limit

*Approved in this revision. v1.0 said "while the trial payment exists", but v1.0
did not give that period. This rule uses the full trial as the period.*

For the whole trial, from admission until evidence freeze, the arbitrary-precision sum of successful transactions associated with it must not exceed its captured amount.

```text
sum(successful_transactions.amount_minor where payment_id = P)
  <= payment.captured_amount_minor
```

### BR-RUA-003 — Stable Logical Identity

Whenever the architecture retries a logical request, every physical attempt must preserve the original `refund_request_id`.

```text
distinct(attempt.refund_request_id for attempts of logical request R) = {R}
```

### BR-RUA-004 — Unknown Outcome

Whenever an attempt is dispatched and then times out, or fails without authoritative proof that it was not dispatched or was rejected before commit, the request's effect knowledge must become `UNKNOWN`.

```text
TIMED_OUT                              -> UNKNOWN
FAILED + DISPATCHED                   -> UNKNOWN
FAILED + UNKNOWN dispatch             -> UNKNOWN
UNKNOWN + any later attempt outcome   -> UNKNOWN
```

`UNKNOWN` is absorbing within this PoC. A later successful response proves only the later effect and does not resolve an earlier ambiguous attempt.

### BR-RUA-005 — Independent Oracle

When the oracle evaluates monetary rules, it must use the complete strongly consistent trial-scoped provider-ledger snapshot. Variant state, logs, metrics, traces, and derived attempt projections may explain an observation but may not replace the ledger.

```text
monetary_evidence_source = complete_strong_ledger_snapshot
```

### BR-RUA-006 — Trial Classification

When the oracle evaluates a trial, it must derive the preservation verdict as follows:

```text
if trial_validity != valid:
  indeterminate
else if any applicable business rule = fail:
  fail
else if any applicable business rule = indeterminate:
  indeterminate
else:
  pass
```

The runner must preserve every `indeterminate` result.

### BR-RUA-007 — Equal Treatment

When two variants are compared, both must receive equal declared business inputs and treatment parameters except for differences explicitly declared as part of the variants' execution strategies.

```text
comparison_eligibility = eligible
only if every equality projection passes and no undeclared difference exists
```

A failed invariant does not make a comparison ineligible. Unequal or undeclared protocol conditions do.

### BR-RUA-008 — Traceability

When a result is evaluated, every verdict-critical input, attempt, provider request, provider call, transaction, observation, manifest, and causal predecessor must be correlatable to the active immutable execution identity.

BR-RUA-008 delegates physical identity uniqueness to INV-RUA-001 rather than duplicating it.

```text
all(verdict_critical_records have the applicable execution identity)
and all(manifest references resolve to the frozen digest)
and all(required evidence_refs resolve to exact indexed bytes)
and all(required causation_event_ids resolve)
and INV-RUA-001 is verified
```

### BR-RUA-009 — Exact Authorized Effect

When a valid isolated full-refund trial settles, the complete successful transaction set must equal exactly one authorized effect.

For request `R`, payment `P`, approved amount `A`, and currency `C`:

```text
successful_transactions =
[
  {
    refund_request_id: R,
    payment_id: P,
    amount_minor: A,
    currency: C,
    status: SUCCEEDED
  }
]
```

One transaction with an incorrect amount, currency, request identity, or payment identity fails BR-RUA-009 even when BR-RUA-001's count equals one. Any additional successful transaction associated with the isolated trial also fails BR-RUA-009.

## Integrity Rule

### INV-RUA-001 — Physical Identity Integrity

Every physical variant attempt must have a unique lowercase UUIDv4 `attempt_id`. Every intended outbound provider request must have a unique lowercase UUIDv4 `provider_request_id`. Every received provider call must have a unique provider-generated lowercase UUIDv4 `provider_call_id`. Every committed monetary effect must have a unique provider-generated lowercase UUIDv4 `provider_transaction_id`.

These identities are unique within their complete execution scope.

```text
count(attempt_id) = count(distinct(attempt_id))
count(provider_request_id) = count(distinct(provider_request_id))
count(provider_call_id) = count(distinct(provider_call_id))
count(provider_transaction_id) = count(distinct(provider_transaction_id))
```

```text
identity_integrity:
  verified | invalid | unverified
```

- Proven caller-generated identity reuse makes identity integrity `invalid`.
- Missing identity evidence makes it `unverified`.
- A duplicate provider-generated call or transaction identity makes evidence integrity `invalid`.
- Invalid or unverified INV-RUA-001 makes the top-level preservation verdict `indeterminate` while independently proven monetary observations remain reported.

INV-RUA-001 is a protocol-validity gate, not a refund business rule.

## Admission Rules

### BR-RUA-017 — Admission validity

Both `captured_amount_minor` and `approved_amount_minor` must:

- be positive integers;
- be no greater than `9007199254740991`;
- use `BRL`;
- be equal because only full refunds are supported.

Every required identifier must be nonempty after whitespace trimming.

Admission rejects zero, negative, fractional, unsafe, unequal, non-BRL, mismatched-currency, or empty-identity inputs. A rejected attempt records its rejection and read-only preflight evidence, creates no canonical manifest or oracle result, and performs no cloud mutation.

## Controlled Provider Contract

### BR-RUA-018 — Controlled provider acceptance

A received call is accepted only when:

- authentication and authorization succeed;
- its schema is valid;
- its execution identity and manifest digest identify the active frozen execution;
- required identities are structurally valid;
- the referenced payment exists;
- the amount is a positive safe integer;
- the currency matches the payment currency.

The provider deliberately does not compare the requested amount or refund identity with the approved decision and does not enforce the cumulative refund limit. Those are properties evaluated by the oracle.

Every received call receives a new provider-generated `provider_call_id`, including rejected calls. A rejected call records `provider_call_rejected`, creates no transaction, and does not consume treatment.

The provider accepts no idempotency key, performs no deduplication, and applies no provider-side call cap. Reusing caller identities does not suppress an accepted effect.

Variants may invoke the refund operation but may not read the authoritative ledger, treatment-control state, or a provider-status endpoint. Only independent experiment components may read the state required for control, settlement, and oracle evaluation.

## Execution Identity and Order

### BR-RUA-019 — Execution order and trial isolation

The canonical run contains exactly four sequential trials:

1. conventional `CONTROL`;
2. Durable `CONTROL`;
3. conventional `COMMIT_THEN_TIMEOUT`;
4. Durable `COMMIT_THEN_TIMEOUT`.

Every trial receives a fresh `trial_id` and fresh state partitions. Partitions are asserted absent before execution and are never reset or reused. Fixed business fixture identifiers may be reused because every lookup and uniqueness boundary includes the trial identity.

Seed `1` is recorded for future deterministic scheduling. The PoC order is explicit and must not be attributed to the seed unless an implemented deterministic scheduling algorithm actually derives it.

The PoC has no batch, repetition index, statistical-sampling dimension, or randomized collection.

## Message-Source Protocol

### BR-RUA-020 — Message-source protocol

Each variant uses a separate but identically configured FIFO source and event consumer except for the declared variant-specific visibility timeout. Both use:

- batch size one;
- no batching window;
- no provisioned polling mode;
- one active message group per trial;
- sequential scheduling;
- equal redrive policy with `maxReceiveCount = 2`;
- a FIFO dead-letter queue;
- no retry jitter.

The protocol does not request an illegal concurrency limit of one. Effective trial concurrency is one because only one FIFO message group is active and the runner schedules trials sequentially.

The conventional path owns retry through one initial source delivery plus one redelivery. It propagates the first treatment timeout as an invocation failure and expects the redelivery only after its visibility timeout.

The Durable path owns retry through one initial step attempt plus one explicit step retry. The second step may succeed without source redelivery. If the full Durable execution fails, a later source redelivery may start a new execution. Configured retries therefore do not establish an absolute provider-call maximum.

## Attempt, Dispatch, Processing, and Knowledge State

### BR-RUA-021 — Dispatch classification

Attempt outcomes:

```text
SUCCEEDED | REJECTED | TIMED_OUT | FAILED
```

Dispatch state:

```text
NOT_DISPATCHED | DISPATCHED | UNKNOWN
```

Every physical attempt begins in a durable pre-dispatch state. `NOT_DISPATCHED` requires a conditional durable transition proving the attempt failed before provider-client dispatch began. Absence of a dispatch event, provider call, or ledger effect does not prove `NOT_DISPATCHED`.

Immediately before invoking transport, the caller records `dispatch_started` and sets `DISPATCHED`. A crash after that boundary remains conservatively dispatched. `SUCCEEDED`, `REJECTED`, and `TIMED_OUT` imply `DISPATCHED`; `FAILED` may carry any dispatch state.

### BR-RUA-022 — Processing state and effect knowledge

Request processing state:

```text
NOT_STARTED | RUNNING | FINISHED
```

Request terminal reason:

```text
SUCCEEDED
| RETRIES_EXHAUSTED
| MESSAGE_REJECTED
| PROVIDER_REJECTED
| INTERRUPTED
| SAFETY_DEADLINE
```

Effect knowledge:

```text
NOT_ATTEMPTED
| NO_EFFECT_CONFIRMED
| ONE_EFFECT_CONFIRMED
| MULTIPLE_EFFECTS_CONFIRMED
| UNKNOWN
```

A definitive provider rejection may establish no effect only when no earlier success or ambiguity exists. A pre-dispatch local failure leaves a first action `NOT_ATTEMPTED`. A timeout followed by a successful retry finishes as:

```text
processing_state = FINISHED
processing_terminal_reason = SUCCEEDED
effect_knowledge_state = UNKNOWN
```

*Approved in this revision.* The effect-knowledge aggregate is a state
model, and v1.0 defines only some of its transitions. The table below follows
the existing rules — BR-RUA-004 makes any ambiguous outcome absorbing, and a
rejection establishes no effect only when no earlier success or ambiguity
exists — and fills the cells v1.0 left open. New decisions are marked ★.

Outcome classes: a **pre-dispatch failure** is `FAILED` with a proven
`NOT_DISPATCHED`; a **rejection** is an authoritative `REJECTED`; a **success**
is `SUCCEEDED`; an **ambiguous** outcome is `TIMED_OUT`, `FAILED` with
`DISPATCHED`, or `FAILED` with `UNKNOWN` dispatch.

| From state | Pre-dispatch failure | Rejection | Success | Ambiguous |
|---|---|---|---|---|
| `NOT_ATTEMPTED` | `NOT_ATTEMPTED` | `NO_EFFECT_CONFIRMED` | `ONE_EFFECT_CONFIRMED` | `UNKNOWN` |
| `NO_EFFECT_CONFIRMED` | `NO_EFFECT_CONFIRMED` | `NO_EFFECT_CONFIRMED` | `ONE_EFFECT_CONFIRMED` ★ | `UNKNOWN` |
| `ONE_EFFECT_CONFIRMED` | `ONE_EFFECT_CONFIRMED` | `ONE_EFFECT_CONFIRMED` | `MULTIPLE_EFFECTS_CONFIRMED` ★ | `UNKNOWN` |
| `MULTIPLE_EFFECTS_CONFIRMED` | `MULTIPLE_EFFECTS_CONFIRMED` ★ | `MULTIPLE_EFFECTS_CONFIRMED` ★ | `MULTIPLE_EFFECTS_CONFIRMED` ★ | `UNKNOWN` |
| `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

Every other transition is refused: nothing leaves `UNKNOWN`, and knowledge
never moves back toward fewer confirmed effects.

### BR-RUA-023 — Application timeout arbitration

After the durable dispatch transition succeeds, the caller captures a source-local monotonic origin, starts the three-second application timer, and invokes transport immediately. One in-process arbiter permits only the timer or transport settlement to win. The timer produces `TIMED_OUT` only when at least three seconds have elapsed, transport remains unsettled, the timer wins, transport abort is requested, and `caller_timeout_recorded` is durably appended. An abort error alone never proves a timeout.

The timeout event records monotonic elapsed nanoseconds, its monotonic origin event, diagnostic dispatch and deadline timestamps, timer-fire time, abort-request time, timeout-record time, and the dispatch event as a causal predecessor. Abort occurs before the durable timeout write so the provider remains behind the barrier until the controller receives that write.

### BR-RUA-024 — Terminality across retry layers

Terminality applies across every configured retry layer. A failed delivery or exhausted inner execution is not request-level `RETRIES_EXHAUSTED` while an upstream layer can still redeliver.

## Scenario Integrity and Treatment Fidelity

### BR-RUA-025 — Control integrity and treatment fidelity

Control integrity:

```text
verified | invalid | unverified | not_applicable
```

A control trial is verified only when immutable provider configuration declares `CONTROL`, treatment was never armed or consumed, no treatment transition occurred, and every accepted provider call returned before its caller deadline. Multiple provider calls do not by themselves invalidate control integrity; monetary rules evaluate their effects.

Treatment fidelity:

```text
verified | invalid | unverified | not_applicable
```

Treatment state:

```text
ARMED
  -> COMMITTED_WAITING
  -> TIMEOUT_SIGNALLED
  -> TIMEOUT_OBSERVED
  -> RESPONSE_RELEASED
```

The first accepted provider call is targeted. The transition to `COMMITTED_WAITING` atomically commits the successful transaction, consumes treatment, and records its attempt, provider request, provider call, transaction, and commit identities. The atomically created ledger transaction, provider event, and consumed treatment state share the same `provider_commit_id`.

The caller durably records `caller_timeout_recorded` but cannot read or modify treatment-control state. An independent controller validates the caller event and conditionally creates `TIMEOUT_SIGNALLED` with both the provider commit and caller timeout as immediate causal predecessors. The provider records `TIMEOUT_OBSERVED` and then `RESPONSE_RELEASED` immediately before returning.

A safety release from any nonterminal wait records `SAFETY_RELEASED` and makes treatment fidelity unverified.

The controller consumes only newly inserted lowercase `caller_timeout_recorded` journal records from the earliest available stream position. It processes one record at a time with no batching window and one sequencing lane. Workload publication waits until this consumer is enabled.

An exact duplicate delivery is idempotent only when the existing signal references the same caller event. A different event attempting the same transition is conflicting control evidence. A signal arriving after safety release records `late_timeout_signal_rejected` and completes without unbounded retry.

Mandatory fidelity fields:

```text
fidelity_basis:
  causal_plus_cross_source_clock_assumption
  | causal
  | not_applicable

clock_assumption_refs: []
```

### CA-1: PoC Clock-Alignment Assumption

```text
assumption_type: clock_alignment
scope: same-account, same-Region AWS Lambda execution environments
statement: UTC wall-clock timestamps preserve the ordering of the provider
           commit and caller timer events for this PoC.
status: declared_not_service_guaranteed
```

CA-1 is a study assumption, not a provider guarantee. Results must describe BR-RUA-010 as empirical ordering under the declared PoC clock-alignment assumption and must not describe it as formal happened-before proof or guaranteed distributed-clock accuracy.

## Transport Qualification Conditions

### BR-RUA-026 — Qualified transport before consumption

The selected transport must pass a distinct real-cloud probe before any study run or variant validation consumes it.

*Moved here in this revision from the former Milestone 0, where it defined when
qualification was complete.* A probe is usable, and may be selected, only when
every transport condition is `pass`, probe validity and treatment fidelity are
valid, evidence is verified, late evidence is not contradictory, its effective
operational closure is clean (cleanup `succeeded`, audit `clean`, lease
`released`), no safety breach is known, its package is verified, and a reusable
transport-scope snapshot exists.

### BR-RUA-010 — Commit Before Timer

The provider transaction must be durably committed before the caller timer wins.

```text
provider.committed_at < caller.timer_fired_at
ordering_basis = cross_source_wall_clock
clock_assumption_refs = [CA-1]
```

Reversed timestamps fail. Equal or missing timestamps are indeterminate. The signed observed timestamp difference is reported but is not interpreted as a clock-error bound.

### BR-RUA-011 — Application Timeout

The application-owned timer must win after at least three seconds of source-local monotonic elapsed time while the transport promise remains unsettled, abort transport, and cause the durable `caller_timeout_recorded` event.

### BR-RUA-012 — Continued Provider Execution

The provider must continue executing after the caller aborts.

### BR-RUA-013 — Causal Join and Observation

The controller signal must be immediately caused by both provider commit and caller timeout, and the provider must subsequently observe that signal.

### BR-RUA-014 — Controlled Release

The provider must release only after timeout observation, and no safety release may occur.

### BR-RUA-015 — No Caller-Observed Success

The caller must never observe a successful provider response for the targeted attempt.

### BR-RUA-027 — Probe verdict derivation

Every condition result is `pass | fail | indeterminate` and includes structured expected and observed values, `evidence_refs`, and `indeterminate_reasons`.

A probe `fail` requires unaffected valid evidence conclusively violating at least one condition and rejects the transport. A probe `indeterminate` leaves it unqualified and permits only a new immutable probe identity.

The isolated probe workload has exact expected cardinality:

```text
caller invocations = 1
accepted provider calls = 1
committed transactions = 1
```

An additional accepted provider call or transaction makes `probe_validity = invalid` and therefore makes the transport verdict indeterminate. Zero calls or transactions are evaluated by the individual TQ conditions as fail or indeterminate according to the available evidence.

Probe-result precedence:

```text
if probe_validity = invalid:
  indeterminate
else if an unaffected TQ condition conclusively fails:
  fail
else if every TQ condition passes and evidence is verified:
  pass
else:
  indeterminate
```

## Qualification Binding

### BR-RUA-028 — Qualification binding

One explicitly selected immutable probe qualifies only the transport implementation scope it actually exercised. The qualification consists of:

- a committed scope policy declaring critical entry points, conservative source roots, configuration projections, runtime properties, and relevant dependencies;
- a frozen snapshot containing the policy digest, resolved paths, transitive production dependency closure, exact source digests, normalized provider and controller configuration, resolved dependency versions, and timing values;
- the selected probe identity, original package-index digest, explicit amendment-head digest when present, and scope-snapshot digest.

The complete dispatch, timeout, abort, and provider-call behavior belongs to one shared provider-client contract. Variants may invoke it but may not reimplement or override it.

Admission recomputes the selected scope against current committed source. Any scoped drift rejects the attempt before manifest freeze and requires a new transport probe. Unrelated oracle, reporting, or orchestration changes do not require a new probe. A later probe never supersedes an earlier probe unless explicitly selected.

## Trial Validity and Verdicts

### BR-RUA-029 — Trial validity and verdict matrix

Applicable validity gates include:

- BR-RUA-005 independent oracle;
- BR-RUA-008 traceability;
- INV-RUA-001 identity integrity;
- control integrity or treatment fidelity;
- complete ledger access;
- environment settlement;
- required rule-specific evidence;
- evidence integrity.

Individual gates use:

```text
verified | invalid | unverified | not_applicable
```

Aggregate trial validity uses:

```text
valid | invalid | indeterminate
```

Derivation precedence:

```text
if any applicable gate = invalid:      invalid
else if any applicable gate = unverified: indeterminate
else:                                  valid
```

Verdict matrix:

| Situation | Preservation verdict | Correct completion |
|---|---|---:|
| Valid control, exact effect, successful terminal processing | `pass` | `true` |
| Verified treatment, exact effect, successful terminal processing | `pass` | `true` |
| Verified treatment, two successful transactions | `fail` | `false` |
| Invalid or unverified treatment with two observed transactions | `indeterminate` with rule failures reported | `null` |
| Ledger unavailable or incomplete | `indeterminate` | `null` |
| Settled valid trial with zero transactions | `fail` | `false` |
| Exact effect with terminal DLQ processing | `pass` | `false` |
| Exact effect but processing active at deadline | `indeterminate` | `null` |
| Required journal or identity evidence missing | `indeterminate` | `null` |
| Proven duplicate with optional telemetry missing | `fail` | `false` |
| Invalid manifest rejected before workload | no oracle result | `null` |

### BR-RUA-030 — Correct completion

Canonical derivation:

```text
correct_completion = true
  only when preservation_verdict = pass
  and processing_terminal_reason = SUCCEEDED

correct_completion = false
  when a valid trial proves an invariant violation
  or a non-successful terminal processing reason

correct_completion = null
  when the trial is indeterminate or never started
```

## Comparison Eligibility

### BR-RUA-031 — Comparison eligibility

A canonical four-cell comparison is `eligible` only when:

- all four declared trials have oracle results;
- every trial-validity gate is valid;
- both controls have verified control integrity;
- both treatment trials have verified treatment fidelity;
- BR-RUA-007 equality passes;
- evidence integrity is verified;
- late evidence is `none` or `consistent`;
- no effective contradictory amendment exists.

Both `pass` and `fail` are comparable outcomes. Invariant failure does not independently make comparison ineligible. Cleanup failure, leak detection, or safety breach remains a separate operational qualification unless it compromised trial isolation, evidence completeness, settlement, or the observation window.

## Settlement

### BR-RUA-032 — Settlement

A trial is settled only when all applicable conditions hold:

- workload publication has stopped;
- request processing has a terminal reason;
- every relevant inner execution is terminal;
- the provider has no active calls, held barriers, or pending releases;
- treatment state is terminal;
- a complete strongly consistent ledger snapshot can be taken;
- the source queue reports zero visible, in-flight, and delayed messages throughout the stabilization interval;
- correlated DLQ messages have been captured;
- no new correlated DLQ message appears during stabilization.

Approximate queue counters cannot establish settlement alone. Correlated activity before freeze resets settlement. If settlement is not established by the observation deadline, preservation is indeterminate and later evidence does not retroactively change it.

## PoC Reference Values

### OR-RUA-001 — Financial fixture

| Field | Value |
|---|---:|
| `currency` | `BRL` |
| `payment_id` | `pay-poc-001` |
| `captured_amount_minor` | `10000` |
| `refund_request_id` | `ref-poc-001` |
| `approved_amount_minor` | `10000` |
| `decision` | `APPROVED` |
| Human-readable amount | BRL 100.00 |
| Expected exact transaction count | `1` |
| Expected exact refunded total | `10000` |

`10000` minor units means BRL 100.00. BRL 10,000.00 would require `1000000` minor units.

### OR-RUA-002 — Timing and retry inputs

| Parameter | PoC value |
|---|---:|
| Provider-client deadline | 3 seconds |
| Provider safety release | 15 seconds after commit |
| Provider execution timeout | 30 seconds |
| Conventional invocation timeout | 10 seconds |
| Durable invocation timeout | 10 seconds |
| Conventional source visibility timeout | 60 seconds |
| Durable source visibility timeout | 360 seconds |
| Durable retry delay | 60 seconds after timeout |
| Durable total step attempts | 2 |
| Durable execution timeout | 300 seconds |
| Source `maxReceiveCount` | 2 |
| Trial observation deadline | 600 seconds after publication |
| Queue stabilization interval | 120 seconds |
| Queue polling interval | 30 seconds |
| Treatment-state polling interval | 250 milliseconds |
| Retry jitter | None |

### OR-RUA-003 — Canonical run safety

| Input | Value |
|---|---:|
| Region | `us-east-1` |
| Maximum active experiment time | 4,500 seconds |
| Reserved cleanup window | 900 seconds |
| Total target | 5,400 seconds |
| Estimated attributable-usage ceiling | USD 5.00 |
| Concurrent owners per Study/account/Region | 1 |

### OR-RUA-004 — Transport-probe safety

| Input | Value |
|---|---:|
| Region | `us-east-1` |
| Active probe time | 600 seconds |
| Reserved cleanup | 600 seconds |
| Total target | 1,200 seconds |
| Estimated attributable-usage ceiling | USD 1.00 |
| Stabilization interval | 120 seconds |

### OR-RUA-005 — Variant-validation safety

Every conventional or Durable variant validation reuses the canonical run maximums:

| Input | Value |
|---|---:|
| Region | `us-east-1` |
| Maximum active validation time | 4,500 seconds |
| Reserved cleanup window | 900 seconds |
| Total target | 5,400 seconds |
| Estimated attributable-usage ceiling | USD 5.00 |
| Concurrent owners per Study/account/Region | 1 |

These values are hard maximums rather than expected durations. An unverified billed-cost check caused solely by delayed or incomplete billing data does not block implementation-validation verification when the admission estimate was within its ceiling, every real-time duration and resource safeguard remained within limits, and no other safety uncertainty exists. A known safety breach or any other unresolved safety condition produces implementation-validation `indeterminate`.

### Expected Configured Trace

These rows are hypotheses for the declared path, not oracle inputs or hard call caps.

| Scenario | Variant | Published messages | Source deliveries | Provider calls | Durable attempts | Successful transactions |
|---|---|---:|---:|---:|---:|---:|
| `CONTROL` | Conventional | 1 | 1 | 1 | N/A | 1 |
| `CONTROL` | Durable | 1 | 1 | 1 | 1 | 1 |
| `COMMIT_THEN_TIMEOUT` | Conventional | 1 | 2 | 2 | N/A | 2 |
| `COMMIT_THEN_TIMEOUT` | Durable | 1 | 1 | 2 | 2 | 2 |

At-least-once behavior means these are not absolute physical-call bounds. Every additional successful transaction is preserved and evaluated normally.

## Acceptance Criteria

The acceptance criteria are the spec's validations: together they prove the
capability works, and an implementation run builds and tests against exactly
this list. Every live business rule is verified by at least one criterion, and
every criterion declares its **Verification:** method and the cases it owes.
`spec-anchored check-spec` checks both.

When the implementation counts as done is defined once, by the implementation
protocol: every criterion green by its declared verification, plus every QA
area that crosses this capability judged, with its findings resolved.

### AC-RUA-001 — Normal Case

Verifies BR-RUA-001, BR-RUA-002, BR-RUA-006, BR-RUA-009, BR-RUA-016 and BR-RUA-030.

- **Given** the valid reference payment, approved request, and `CONTROL`
- **When** either variant completes and the trial settles
- **Then** the ledger contains exactly the authorized successful transaction
- **And** BR-RUA-001, BR-RUA-002, and BR-RUA-009 pass
- **And** the oracle returns `pass`
- **And** successful terminal processing produces `correct_completion = true`.

**Verification:** golden — frozen synthetic evidence of one settled `CONTROL` trial, evaluated offline by the oracle; cases: conventional variant, Durable variant.

### AC-RUA-002 — Commit Followed by Timeout

Verifies BR-RUA-010, BR-RUA-011, BR-RUA-012, BR-RUA-013, BR-RUA-014, BR-RUA-015, BR-RUA-023 and BR-RUA-025.

- **Given** an admitted treatment trial with the first accepted provider call targeted
- **When** the provider atomically commits and the application timer wins
- **Then** BR-RUA-010 through BR-RUA-015 are evaluated from frozen evidence
- **And** verified fidelity identifies CA-1 and `causal_plus_cross_source_clock_assumption`
- **And** the result does not claim formal happened-before proof or an AWS clock guarantee.

**Verification:** e2e — real-cloud transport probe in `us-east-1`; golden — the condition derivation over the probe's frozen evidence.

### AC-RUA-003 — Observed Result After a Retry

Verifies BR-RUA-003, BR-RUA-004 and BR-RUA-020.

- **Given** a first attempt with `TIMED_OUT` and effect knowledge `UNKNOWN`
- **When** the architecture executes its configured retry path
- **Then** every attempt retains the logical refund identity
- **And** aggregate effect knowledge remains `UNKNOWN`
- **And** every provider call and transaction is preserved
- **And** the oracle returns the evidence-derived preservation verdict.

**Verification:** golden — frozen evidence of a treatment trial per variant; cases: conventional redelivery path, Durable step-retry path.

### AC-RUA-004 — Duplicate Detection

Verifies BR-RUA-001, BR-RUA-002, BR-RUA-006 and BR-RUA-009.

- **Given** a complete ledger snapshot with two successful full-refund transactions
- **When** the oracle evaluates a valid settled trial
- **Then** BR-RUA-001, BR-RUA-002, and BR-RUA-009 fail
- **And** preservation is `fail`
- **And** the trial remains scientifically valid.

**Verification:** golden — cases: two transactions in a verified treatment trial; two transactions in a valid `CONTROL` trial, where multiple calls do not invalidate control integrity.

### AC-RUA-005 — Missing Effect Detection

Verifies BR-RUA-001 and BR-RUA-009.

- **Given** an approved request with zero successful transactions in a complete settled ledger
- **When** the oracle evaluates the valid trial
- **Then** BR-RUA-001 and BR-RUA-009 fail
- **And** preservation is `fail`.

**Verification:** golden — a complete settled ledger with zero successful transactions.

### AC-RUA-006 — Authoritative Source

Verifies BR-RUA-005.

- **Given** variant state claims success but the complete ledger lacks the authorized transaction
- **When** the oracle evaluates the trial
- **Then** the ledger controls the monetary result
- **And** variant state cannot override it.

**Verification:** golden — variant state reporting success against a complete ledger without the authorized transaction.

### AC-RUA-007 — Insufficient Evidence

Verifies BR-RUA-006, BR-RUA-029 and BR-RUA-032.

- **Given** ledger access is incomplete, settlement is not established, or verdict-critical evidence is missing
- **When** the oracle evaluates the trial
- **Then** affected rule checks are `indeterminate`
- **And** preservation is `indeterminate`
- **And** structured reasons identify the missing evidence.

**Verification:** golden — one case per missing input: incomplete ledger pagination; settlement not established by the observation deadline; a verdict-critical journal absent.

### AC-RUA-008 — Controlled Repetition

Verifies BR-RUA-019, BR-RUA-028, BR-RUA-040 and BR-RUA-042.

- **Given** a valid execution definition
- **When** admission succeeds
- **Then** identities, order, inputs, timing, safety, source revision, qualification, schemas, and dependencies freeze before mutation
- **And** every result references those exact frozen bytes.

**Verification:** integration — admission against local emulation; cases: every declared field frozen before the first mutation; four trials in the declared order with fresh identities and partitions asserted absent; a changed declared field requires a new execution identity.

### AC-RUA-009 — Equality Between Variants

Verifies BR-RUA-007, BR-RUA-020 and BR-RUA-031.

- **Given** all four canonical trials
- **When** the runner evaluates BR-RUA-007
- **Then** declared common inputs and treatment parameters compare equal
- **And** only declared variant differences remain
- **And** unequal undeclared conditions make comparison ineligible without erasing individual verdicts.

**Verification:** golden — four-trial evidence; cases: every equality projection passes; one undeclared difference makes comparison ineligible while each individual verdict stays intact.

### AC-RUA-010 — Minimum Evidence Package

Verifies BR-RUA-008, BR-RUA-035, BR-RUA-037 and BR-RUA-043.

- **Given** a trial reaches evidence freeze
- **When** its evidence index is generated
- **Then** every applicable verdict-critical manifest, input, journal, provider event, ledger snapshot, queue observation, conditional DLQ snapshot, and authoritative execution record is indexed by exact bytes
- **And** derived artifacts remain distinguishable from primary evidence.

**Verification:** golden — evidence-index generation; cases: each primary artifact class indexed by exact bytes; derived artifacts flagged as derived; the index excludes itself and the late-evidence area.

### AC-RUA-011 — Verifiable Cleanup

Verifies BR-RUA-048, BR-RUA-049, BR-RUA-050 and BR-RUA-051.

- **Given** an execution succeeds, fails, becomes indeterminate, or is interrupted
- **When** cleanup runs one or more times
- **Then** deletion occurs only for conservatively proven owned resources
- **And** already absent owned resources are successful deletions
- **And** leak-audit results preserve leaks and inconclusive ownership rather than deleting ambiguously owned resources.

**Verification:** integration — cleanup against stubbed discovery surfaces; cases: succeeded, failed, indeterminate and interrupted executions; cleanup run twice; resources already absent; an ambiguously owned resource reported and never deleted.

### AC-RUA-012 — Result Does Not Follow the Hypothesis

Verifies BR-RUA-006 and BR-RUA-043.

- **Given** observed evidence contradicts the initial hypothesis
- **When** the oracle and summaries are produced
- **Then** the calculated observations remain unchanged and included
- **And** no trial is altered or excluded to support the hypothesis.

**Verification:** golden — treatment trials whose evidence contradicts the initial hypothesis; cases: the oracle results and the run summary include them unaltered.

### AC-RUA-013 — Exact-Effect Mismatch

Verifies BR-RUA-001 and BR-RUA-009.

- **Given** exactly one successful transaction with an incorrect amount, currency, request identity, or payment identity
- **When** the oracle evaluates a valid trial
- **Then** BR-RUA-001 may pass its count check
- **But** BR-RUA-009 fails
- **And** preservation is `fail`.

**Verification:** golden — one transaction with: a wrong amount; a wrong currency; a wrong request identity; a wrong payment identity.

### AC-RUA-014 — Pre-Execution Rejection

Verifies BR-RUA-017, BR-RUA-039, BR-RUA-041, BR-RUA-042 and BR-RUA-046.

- **Given** invalid financial input, identity, source provenance, account, Region, safety, qualification, or coordination configuration
- **When** read-only admission runs
- **Then** a structured rejection and preflight journal are preserved
- **And** no canonical manifest, trial, oracle result, package index, or cloud mutation is created.

**Verification:** integration — read-only admission; one case per rejected input class: financial input, identity, source provenance, account, Region, safety, qualification, coordination configuration.

### AC-RUA-015 — Dispatch Classification: Proven Pre-Dispatch Failure

*Split from the former AC-15; its second scenario is AC-RUA-028.*

Verifies BR-RUA-021.

- **Given** an attempt fails before dispatch
- **When** a conditional durable transition proves it remained pre-dispatch
- **Then** dispatch state is `NOT_DISPATCHED`
- **And** a first action retains `NOT_ATTEMPTED`.

**Verification:** unit — a durable-transition double; case: a failure before dispatch with the conditional transition recorded.

### AC-RUA-016 — Unknown Knowledge Is Absorbing

Verifies BR-RUA-004 and BR-RUA-022.

- **Given** any attempt establishes `UNKNOWN`
- **When** a later attempt succeeds, fails, or is rejected
- **Then** aggregate effect knowledge remains `UNKNOWN`
- **And** processing may independently finish.

**Verification:** unit — cases: `UNKNOWN` followed by a success, a failure and a rejection.

### AC-RUA-017 — Physical Identity Integrity

Verifies INV-RUA-001 and BR-RUA-029.

- **Given** caller identity reuse, missing physical identity evidence, or provider-generated identity collision
- **When** INV-RUA-001 and evidence integrity are evaluated
- **Then** the appropriate integrity gate is invalid or unverified
- **And** preservation is `indeterminate`
- **And** independently proven monetary observations remain reported.

**Verification:** golden — cases: caller identity reuse makes identity integrity `invalid`; missing identity evidence makes it `unverified`; a provider-generated collision makes evidence integrity `invalid`.

### AC-RUA-018 — Control Integrity Verified

*Split from the former AC-18; its second scenario is AC-RUA-029.*

Verifies BR-RUA-025.

- **Given** a `CONTROL` trial
- **When** treatment is never armed or consumed and every accepted call returns before its deadline
- **Then** control integrity is `verified`.

**Verification:** golden — clean `CONTROL` evidence.

### AC-RUA-019 — Consumer Manifest Mismatch

Verifies BR-RUA-036.

- **Given** a published message whose execution identity or trial-manifest digest does not match the active frozen trial
- **When** a consumer validates it
- **Then** the consumer records `MESSAGE_REJECTED`
- **And** makes no provider call
- **And** effect knowledge remains `NOT_ATTEMPTED`
- **And** the started trial is `indeterminate`.

**Verification:** integration — a consumer receiving a mismatched message; cases: wrong execution identity; wrong trial-manifest digest.

### AC-RUA-020 — Settlement Restarts on Activity Before Freeze

*Split from the former AC-20; its second scenario is AC-RUA-030.*

Verifies BR-RUA-032.

- **Given** correlated activity appears before evidence freeze
- **When** settlement is being observed
- **Then** stabilization restarts.

**Verification:** integration — simulated queue observations; cases: a visible message, an in-flight message and a new correlated DLQ message during stabilization.

### AC-RUA-021 — Transport Qualification Passes

*Split from the former AC-21; its other outcomes are AC-RUA-031 and AC-RUA-032.*

Verifies BR-RUA-026 and BR-RUA-027.

- **Given** clean admitted probe inputs and one isolated provider call
- **When** the real-cloud qualification executes
- **Then** a `pass` requires every TQ condition to pass, valid probe fidelity, verified evidence, expected cardinality, and no safety release
- **And** only a passing usable probe may be selected by later executions.

**Verification:** e2e — real-cloud probe in `us-east-1`; golden — the probe verdict derivation over its frozen evidence.

### AC-RUA-022 — Immutable Package Verification

Verifies BR-RUA-043 and BR-RUA-044.

- **Given** an original package index and an explicitly selected amendment head
- **When** the package verifier runs
- **Then** it validates every indexed byte, chain parent, sequence, reference, and known descendant
- **And** returns `eligible` only for a complete noncontradictory selected chain
- **And** package eligibility does not imply preservation, implementation, comparison, or study-completion success.

**Verification:** unit — package fixtures; cases: an altered byte; a broken chain parent; a sequence gap; a cycle; an unknown descendant; a complete noncontradictory chain is `eligible`.

### AC-RUA-023 — Lease Uncertainty

*Split from the former AC-23; the loss scenario is AC-RUA-033.*

Verifies BR-RUA-045.

- **Given** a failed lease heartbeat
- **When** ownership remains unconfirmed
- **Then** new publication stops immediately
- **And** confirmed ownership may resume only before the stale boundary.

**Verification:** integration — coordination-store emulation with an injected heartbeat failure; cases: recovery before the stale boundary resumes scheduling.

### AC-RUA-024 — Attributable Cost Compared

*Split from the former AC-24; the unverified scenario is AC-RUA-034.*

Verifies BR-RUA-047.

- **Given** a later billing export
- **When** exact resource, ownership, operation, account, currency, and usage-window correlation is possible
- **Then** attributable USD usage is compared with the declared ceiling.

**Verification:** unit — billing-export fixtures; cases: usage within the ceiling; usage above the ceiling.

### AC-RUA-025 — Variant Validation Verified

*Split from the former AC-25; its other outcomes are AC-RUA-035 and AC-RUA-036.*

Verifies BR-RUA-038.

- **Given** one variant's sequential control and treatment validation trials
- **When** both yield trustworthy conclusive evidence and operational acceptance gates are satisfied
- **Then** control `pass` plus treatment `pass` or `fail` produces implementation-validation `verified`
- **And** the package makes no cross-variant claim.

**Verification:** golden — cases: treatment `pass`; treatment `fail`.

### AC-RUA-026 — Operational Recovery of a Variant Validation

*Split from the former AC-26; its negative scenario is AC-RUA-037.*

Verifies BR-RUA-038 and BR-RUA-044.

- **Given** scientifically valid frozen validation evidence with incomplete cleanup, audit, or lease closure
- **When** a valid amendment chain repairs only those operational conditions
- **Then** a verifier may derive effective cleanup `succeeded`, audit `clean`, lease `released`, and implementation status `verified` or `failed`
- **And** the original summary and scientific results remain unchanged.

**Verification:** golden — amendment-chain fixtures; cases: cleanup repaired; audit repaired; lease repaired.

### AC-RUA-027 — Canonical Four-Cell Completion

*Split from the former AC-27; its negative scenario is AC-RUA-038.*

Verifies BR-RUA-007, BR-RUA-031 and BR-RUA-054.

- **Given** a clean-source canonical run with all four settled trial results
- **When** BR-RUA-007 and all validity, integrity, late-evidence, package, cleanup, audit, lease, and safety checks complete
- **Then** study completion requires `comparison_eligibility = eligible`
- **And** original cleanup is `succeeded`, audit is `clean`, and lease is `released`
- **And** treatment `fail` results remain admissible observations.

**Verification:** e2e — the canonical run in `us-east-1`; golden — the run-summary derivation.

### AC-RUA-028 — Dispatch Boundary Crossed or Not Locatable

*Split from the former AC-15.*

Verifies BR-RUA-021.

- **Given** the dispatch boundary was crossed or cannot be located
- **When** the attempt is classified
- **Then** the attempt is `DISPATCHED` or `UNKNOWN`
- **And** no absence observation may prove non-dispatch.

**Verification:** unit — cases: a crash after `dispatch_started`; a dispatch boundary that cannot be located; an absent provider call and ledger effect that still prove nothing.

### AC-RUA-029 — Control Integrity Invalid

*Split from the former AC-18.*

Verifies BR-RUA-006 and BR-RUA-025.

- **Given** a `CONTROL` trial
- **When** treatment or an uncontrolled timeout is proven
- **Then** control integrity is `invalid`
- **And** preservation is `indeterminate`.

**Verification:** golden — cases: treatment armed; treatment consumed; an uncontrolled timeout.

### AC-RUA-030 — Late Evidence After Freeze

*Split from the former AC-20.*

Verifies BR-RUA-031 and BR-RUA-043.

- **Given** correlated activity appears after evidence freeze
- **When** late evidence is assessed
- **Then** it is preserved as late evidence
- **And** the frozen result and original digests remain unchanged
- **And** contradictory late evidence blocks qualification or comparison as applicable.

**Verification:** golden — cases: consistent late evidence; contradictory late evidence.

### AC-RUA-031 — Transport Qualification Fails

*Split from the former AC-21.*

Verifies BR-RUA-010, BR-RUA-011, BR-RUA-012, BR-RUA-013, BR-RUA-014, BR-RUA-015 and BR-RUA-027.

- **Given** clean admitted probe inputs and unaffected valid evidence
- **When** at least one transport condition is conclusively violated
- **Then** the probe verdict is `fail`
- **And** the transport is rejected.

**Verification:** golden — one case per transport condition conclusively violated, including reversed commit and timer timestamps (BR-RUA-010) and a caller that observes a successful targeted response (BR-RUA-015).

### AC-RUA-032 — Transport Qualification Is Indeterminate

*Split from the former AC-21.*

Verifies BR-RUA-010, BR-RUA-014 and BR-RUA-027.

- **Given** probe evidence that is insufficient, or a probe that is invalid
- **When** the probe verdict is derived
- **Then** the verdict is `indeterminate`
- **And** the transport stays unqualified, and only a new immutable probe identity may follow.

**Verification:** golden — cases: equal commit and timer timestamps; a missing timestamp; a safety release; an additional accepted provider call, which makes the probe invalid.

### AC-RUA-033 — Lease Loss

*Split from the former AC-23.*

Verifies BR-RUA-045.

- **Given** a failed lease heartbeat
- **When** ownership mismatch or staleness is established
- **Then** active work is interrupted and emergency cleanup begins
- **And** TTL expiry alone never proves release.

**Verification:** integration — coordination-store emulation; cases: ownership mismatch; staleness past the 300-second boundary; TTL expiry without a confirmed release.

### AC-RUA-034 — Attributable Cost Unverified

*Split from the former AC-24.*

Verifies BR-RUA-047.

- **Given** a later billing export
- **When** attribution is incomplete or any attributable line is non-USD
- **Then** billed-cost safety is `unverified`
- **And** no proportional allocation or exchange-rate conversion occurs.

**Verification:** unit — billing-export fixtures; cases: incomplete attribution; one non-USD line; mixed currencies.

### AC-RUA-035 — Variant Validation Failed

*Split from the former AC-25.*

Verifies BR-RUA-038.

- **Given** one variant's validation trials with trustworthy conclusive evidence
- **When** the control trial's preservation is `fail`
- **Then** implementation validation is `failed`.

**Verification:** golden — a trustworthy control `fail`.

### AC-RUA-036 — Variant Validation Indeterminate

*Split from the former AC-25.*

Verifies BR-RUA-038.

- **Given** one variant's validation trials
- **When** scientific or operational acceptance is indeterminate
- **Then** implementation validation is `indeterminate`.

**Verification:** golden — cases: an indeterminate scientific condition; an indeterminate operational condition.

### AC-RUA-037 — Scientific Evidence Cannot Be Repaired Operationally

*Split from the former AC-26.*

Verifies BR-RUA-038 and BR-RUA-044.

- **Given** frozen validation evidence that is missing or scientifically invalid
- **When** an amendment chain attempts operational recovery
- **Then** the effective implementation status remains `indeterminate`.

**Verification:** golden — cases: missing scientific evidence; invalid admission or fidelity; manifest drift.

### AC-RUA-038 — A Recovered Run Cannot Complete the Study

*Split from the former AC-27.*

Verifies BR-RUA-054.

- **Given** a canonical run whose original cleanup, audit or lease closure was not clean
- **When** an operational recovery amendment repairs it
- **Then** the run still cannot complete the study.

**Verification:** golden — an original package with non-clean closure plus a valid recovery chain.

### AC-RUA-039 — A Retry Breaks the Logical Identity

*Added in this revision; derived from BR-RUA-003.*

Verifies BR-RUA-003.

- **Given** a retry attempt that carries a `refund_request_id` other than the original
- **When** the oracle evaluates the valid settled trial
- **Then** BR-RUA-003 fails
- **And** preservation is `fail`.

**Verification:** golden — an attempt journal whose second attempt changes the logical identity.

### AC-RUA-040 — One Transaction Exceeds the Payment Limit

*Added in this revision; derived from BR-RUA-002 and BR-RUA-009.*

Verifies BR-RUA-002 and BR-RUA-009.

- **Given** exactly one successful transaction of `20000` minor units against a captured `10000`
- **When** the oracle evaluates the valid settled trial
- **Then** BR-RUA-001 passes its count check
- **But** BR-RUA-002 and BR-RUA-009 fail
- **And** preservation is `fail`.

**Verification:** golden — a single over-limit transaction.

### AC-RUA-041 — An Untraceable Verdict-Critical Record

*Approved in this revision. v1.0 lists BR-RUA-008 as a validity gate, but it
does not give the gate value for a record without a correlation. If the record
has no correlation, the gate value is `unverified`. If the correlation refers to
a different execution, the gate value is `invalid`.*

Verifies BR-RUA-008 and BR-RUA-029.

- **Given** a verdict-critical record that cannot be correlated to the active execution identity
- **When** the oracle evaluates the trial
- **Then** the traceability gate is `unverified` when correlation is missing and `invalid` when it names another execution
- **And** preservation is `indeterminate`.

**Verification:** golden — cases: a provider call without execution identity; an execution identity from another trial; an unresolved causal predecessor.

### AC-RUA-042 — The Provider Rejects an Invalid Call

*Added in this revision; derived from BR-RUA-016 and BR-RUA-018.*

Verifies BR-RUA-016 and BR-RUA-018.

- **Given** a received call that fails any acceptance condition
- **When** the controlled provider processes it
- **Then** it records `provider_call_rejected` with a new provider-generated `provider_call_id`
- **And** it creates no transaction and does not consume treatment.

**Verification:** unit — one case per acceptance condition: authentication or authorization; schema; execution identity and manifest digest; identity structure; an unknown payment; a non-positive or unsafe amount; a currency mismatch.

### AC-RUA-043 — Effect Knowledge Follows the Transition Table

*Approved in this revision. This criterion uses the transition table in
BR-RUA-022.*

Verifies BR-RUA-022.

- **Given** any effect-knowledge state and any attempt outcome
- **When** the aggregate is updated
- **Then** the resulting state is the table's cell
- **And** every transition outside the table is refused.

**Verification:** unit — every cell of the table; every refused transition.

### AC-RUA-044 — An Abort Error Alone Never Proves a Timeout

*Added in this revision; derived from BR-RUA-023.*

Verifies BR-RUA-023.

- **Given** the transport aborts with an error
- **When** fewer than three seconds have elapsed, the timer did not win, or `caller_timeout_recorded` was not durably appended
- **Then** the attempt is not `TIMED_OUT`.

**Verification:** unit — a fake clock and transport; cases: abort before three seconds; transport settles first; the durable timeout write fails.

### AC-RUA-045 — Terminality Spans Every Retry Layer

*Added in this revision; derived from BR-RUA-024.*

Verifies BR-RUA-024.

- **Given** a failed delivery or an exhausted inner execution
- **When** an upstream layer can still redeliver
- **Then** request-level processing is not `RETRIES_EXHAUSTED`.

**Verification:** unit — cases: a conventional failed delivery before the second receive; a Durable execution exhausted before source redelivery.

### AC-RUA-046 — Records Conform to Their Contracts

*Added in this revision; derived from BR-RUA-033 and the record contracts.*

Verifies BR-RUA-033, CTR-RUA-001, CTR-RUA-002, CTR-RUA-003, CTR-RUA-004, CTR-RUA-005 and CTR-RUA-006.

- **Given** any record the study writes
- **When** it is validated against its schema
- **Then** it conforms to the serialization contract and to its record contract.

**Verification:** contract — schema validation of every record type; cases: casing rules, millisecond UTC timestamps, lowercase UUIDv4 identifiers, safe-integer amounts, decimal-string aggregates, omitted versus `null`, `schema_version` and `record_type` present. fuzz — the JSON, JSONL and package parsers never crash on malformed input.

### AC-RUA-047 — Duplicates and Conflicts Are Classified

*Added in this revision; derived from BR-RUA-034.*

Verifies BR-RUA-034.

- **Given** ingested evidence containing a duplicate or a conflict
- **When** evidence is ingested and indexed
- **Then** each listed case produces its declared classification.

**Verification:** golden — one case per rule: an equivalent duplicate collapsed; conflicting content under one `event_id`; conflicting events under one source and sequence; a sequence gap; a missing causal predecessor; a duplicate ledger transaction identity; incomplete ledger pagination; a core-file digest mismatch; a ledger larger than expected, never truncated.

### AC-RUA-048 — Evidence References Are Well Formed

*Added in this revision; derived from BR-RUA-035.*

Verifies BR-RUA-035.

- **Given** a result with `evidence_refs`
- **When** the references are validated
- **Then** malformed references are rejected
- **And** a `pass` or `fail` result carries at least one reference.

**Verification:** unit — cases: an absolute path; parent traversal; unsorted entries; a duplicate entry; an alias field name; a `pass` without references; an indeterminate result caused by missing evidence, with an empty array and a structured reason.

### AC-RUA-049 — The Safety Deadline Is Reached

*Added in this revision; derived from BR-RUA-046.*

Verifies BR-RUA-046.

- **Given** an active run
- **When** the active-time deadline is reached
- **Then** no new trial starts and active work enters controlled interruption
- **And** available evidence is preserved and emergency cleanup begins
- **And** cleanup continues past the total target, recording a duration breach.

**Verification:** integration — a fake clock; cases: the deadline during a trial; the deadline between trials.

### AC-RUA-050 — Operational Failure Never Rewrites a Verdict

*Added in this revision; derived from BR-RUA-052.*

Verifies BR-RUA-031 and BR-RUA-052.

- **Given** a frozen trial verdict
- **When** cleanup fails or the leak audit is not clean
- **Then** the frozen verdict is unchanged
- **And** comparison stays eligible only when isolation, settlement and evidence were not compromised.

**Verification:** golden — cases: a cleanup failure without compromise; a leak capable of later correlated effects.

### AC-RUA-051 — Qualification Drift Is Refused

*Added in this revision; derived from BR-RUA-028.*

Verifies BR-RUA-028.

- **Given** a selected transport probe
- **When** admission recomputes its scope against current committed source
- **Then** any scoped drift rejects the attempt before manifest freeze
- **And** unrelated oracle, reporting or orchestration changes do not require a new probe.

**Verification:** integration — cases: a scoped source change; a scoped dependency change; an unrelated oracle change.

### AC-RUA-052 — Exact Effect With Non-Successful Terminal Processing

*Added in this revision; derived from the verdict matrix.*

Verifies BR-RUA-029 and BR-RUA-030.

- **Given** a valid trial whose ledger holds exactly the authorized effect
- **When** request processing terminates through the dead-letter queue
- **Then** preservation is `pass`
- **And** `correct_completion` is `false`.

**Verification:** golden — an exact effect with terminal DLQ processing.

### AC-RUA-053 — Platform and Transport Constraints Hold

*Added in this revision; derived from BR-RUA-053.*

Verifies BR-RUA-053.

- **Given** the frozen deployment assembly
- **When** it is inspected before the first mutation
- **Then** provider-client automatic retries are disabled, the immutable provider version is recorded, lower-level timeouts cannot preempt the application deadline, and the complete Durable execution fits the direct event-source invocation limit.

**Verification:** integration — inspection of the synthesized assembly and the client configuration; one case per constraint.

### AC-RUA-054 — Missing Telemetry Does Not Block a Verdict

*Added in this revision; derived from BR-RUA-037.*

Verifies BR-RUA-037.

- **Given** a trial whose logs, metrics or traces are unavailable
- **When** the oracle evaluates it with complete primary evidence
- **Then** the verdict is derived normally
- **And** the telemetry's unavailability is recorded.

**Verification:** golden — cases: logs missing; metrics missing; traces missing.

### AC-RUA-055 — The Oracle Is Final Before Cloud Evidence

*Approved in this revision. This criterion uses BR-RUA-055.*

Verifies BR-RUA-055.

- **Given** a canonical run's frozen manifest
- **When** its recorded source revision is checked out
- **Then** the oracle's golden cases for every verdict-changing rule pass at that revision.

**Verification:** golden — the oracle golden suite run at the manifest's source revision.

### AC-RUA-056 — A Passing Probe That Is Not Usable Cannot Be Selected

*Added in this revision; derived from BR-RUA-026, which now carries the former Milestone 0 conditions.*

Verifies BR-RUA-026.

- **Given** a probe whose transport conditions all pass
- **When** any usability condition is unmet
- **Then** later executions cannot select it.

**Verification:** golden — one case per unmet condition: unclean operational closure; a package not verified; contradictory late evidence; no transport-scope snapshot; a known safety breach.

## Serialization Contract

### BR-RUA-033 — Serialization contract

- JSON and JSONL use UTF-8.
- Properties use `snake_case`.
- Every JSON record and JSONL line contains `schema_version: 1` and a lowercase `record_type`.
- Schema versions apply to their specific record types rather than one global repository version.
- Domain and lifecycle enum values remain uppercase; verdict, validity, and eligibility values remain lowercase.
- Optional properties are omitted when unavailable. `null` is used only when absence has explicit meaning.
- Required collections serialize as `[]` when empty.
- Object property order has no semantic meaning.
- Timestamps use UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` with exactly millisecond precision.
- File digests are lowercase SHA-256 over the exact stored bytes.
- Individual `amount_minor` values are safe-integer JSON numbers.
- Derived monetary aggregates are base-10 decimal strings.

Generated `run_id`, `trial_id`, `attempt_id`, `provider_request_id`, `provider_call_id`, `provider_transaction_id`, `provider_commit_id`, `event_id`, `source_instance_id`, transport-probe identity, and variant-validation identity are canonical lowercase UUIDv4 strings.

Every primary event contains:

```text
schema_version
record_type
event_id
execution identity and manifest digest
occurred_at
source
source_instance_id
source_sequence
causation_event_ids   # optional
record-specific correlation identifiers
```

`source_sequence` is a positive safe integer starting at one, dense and strictly increasing within `(source, source_instance_id)`. A writer serializes its appends. It retries a definitive failed append using identical event identity, content, and sequence. After an ambiguous append result, that source instance stops emitting events. A restart creates a new source instance.

`causation_event_ids` is omitted for causal roots. Otherwise it is a lexicographically sorted array of unique lowercase UUIDv4 immediate predecessors. Correlation alone does not prove causality.

Source-local monotonic elapsed nanoseconds are nonnegative canonical base-10 strings. Absolute process-local monotonic clock values are never serialized or compared between source instances.

## Duplicate and Conflict Handling

### BR-RUA-034 — Duplicate and conflict handling

- Repeated `event_id` with structurally equivalent parsed JSON is an ingestion duplicate and is collapsed with a diagnostic count.
- Object order and insignificant whitespace do not affect structural equivalence; array order and JSON types do.
- Conflicting content under one event identity makes evidence integrity invalid.
- Conflicting events under one source and sequence make evidence integrity invalid.
- A dense source-sequence gap makes checks relying on that source instance indeterminate.
- Missing required causal predecessors make affected checks indeterminate.
- Duplicate ledger transaction identity invalidates the ledger snapshot.
- Incomplete ledger pagination makes the ledger incomplete.
- Core-file digest mismatch makes evidence integrity invalid, the affected trial indeterminate, and comparison ineligible.
- Evidence collection never truncates a ledger because of an expected size.

## Evidence Reference Contract

### BR-RUA-035 — Evidence references

Every `evidence_refs` entry contains:

```text
artifact_path
artifact_sha256
event_id              # optional
json_pointer           # optional
package_index_sha256   # required for cross-package references
```

Paths are normalized package-relative POSIX paths. Absolute paths and parent traversal are forbidden. References are sorted canonically and duplicates are rejected. A `pass` or `fail` result requires at least one reference. An indeterminate result caused entirely by missing evidence may use an empty array when its structured reason identifies the missing artifact or event.

Aliases such as `evidence_references`, `evidence`, and `references` are rejected.

## Input Contracts

### CTR-RUA-005 — Payment

```json
{
  "schema_version": 1,
  "record_type": "payment",
  "payment_id": "pay-poc-001",
  "captured_amount_minor": 10000,
  "currency": "BRL"
}
```

### CTR-RUA-006 — Approved decision

```json
{
  "schema_version": 1,
  "record_type": "approved_decision",
  "refund_request_id": "ref-poc-001",
  "payment_id": "pay-poc-001",
  "decision": "APPROVED",
  "approved_amount_minor": 10000,
  "currency": "BRL"
}
```

### BR-RUA-036 — Published trial message

Every canonical message contains:

```text
schema_version
record_type
run_id or variant_validation_id
trial_id
trial_manifest_sha256
payment_id
refund_request_id
```

A pre-publication mismatch rejects setup and starts no trial. A post-publication consumer mismatch records `MESSAGE_REJECTED`, calls no provider, and makes the trial indeterminate.

## Primary and Derived Evidence

### BR-RUA-037 — Primary and derived evidence

Primary frozen evidence includes:

- immutable execution and trial manifests;
- payment, approved decision, and exact published message;
- caller and variant journal events;
- provider and treatment events;
- complete strongly consistent ledger snapshot;
- repeated source-queue and DLQ observations;
- a conditional correlated DLQ snapshot;
- authoritative variant-specific execution metadata;
- coordination events or a prefix checkpoint where coordination remains active through cleanup;
- the exact frozen deployment assembly and its canonical inventory.

Derived artifacts include:

- attempt projections;
- oracle results;
- run, probe, and validation summaries;
- evidence indexes;
- package verification results.

The PoC does not create a second ledger-transaction JSONL representation unless it carries information absent from the authoritative ledger snapshot.

Logs, metrics, and traces are diagnostic. Their availability and references are recorded, but their absence alone does not block a verdict.

## Oracle Result Contract

### CTR-RUA-001 — Oracle result

Every oracle result contains:

```text
schema_version
record_type
execution identity
trial_id
trial_manifest_sha256
preservation_verdict
correct_completion
processing_terminal_reason
trial_validity
identity_integrity
control_integrity
treatment_fidelity
fidelity_basis
clock_assumption_refs
rule_results[]
indeterminate_reasons[]
ledger_snapshot_ref
checked_at
```

Every applicable business and integrity rule appears in `rule_results`, including successful, indeterminate, and not-applicable results. Each entry has its stable identifier, result, structured expected and observed values, and `evidence_refs`.

`ledger_snapshot_ref` contains the package-relative path and exact digest. `processing_terminal_reason` may be `null` only when no terminal state was established.

## Run Summary Contract

### CTR-RUA-002 — Run summary

A canonical run summary contains exactly four trial-result entries corresponding to the four declared trial identities. Each entry contains execution status, optional oracle-result reference, and rejection or incompletion reasons where no oracle exists.

The summary separately records:

```text
execution_status: completed | incomplete
run_terminal_reason
comparison_eligibility: eligible | ineligible
comparison_ineligibility_reasons[]
cleanup_status
leak_audit_status
lease_status
safety_status
evidence_integrity_status
cleanup_result_ref
late_evidence_assessment_ref
```

It reports no winner, aggregate performance claim, or statistical conclusion.

Canonical run terminal reasons:

```text
COMPLETED
LEASE_ACQUISITION_FAILED
LEASE_LOST
PROVISIONING_FAILED
TRIAL_INCOMPLETE
SAFETY_DEADLINE
OPERATOR_ABORT
INTERRUPTED
CLEANUP_INCOMPLETE
LEAK_AUDIT_NOT_CLEAN
EVIDENCE_FINALIZATION_FAILED
```

The first specific causal condition that prevents clean completion remains primary. Later failures remain visible through their separate status fields and journals.

## Transport-Probe Result Contract

### CTR-RUA-003 — Transport-probe result

The probe result freezes before cleanup and contains:

```text
transport_probe_verdict: pass | fail | indeterminate
probe_validity: valid | invalid | indeterminate
evidence_integrity: verified | invalid | unverified
treatment_fidelity
fidelity_basis
clock_assumption_refs[]
condition_results[]
evidence_refs[]
checked_at
```

The later probe summary records lifecycle, cleanup, audit, lease, safety, late evidence, and the probe-result digest. `COMPLETED` means the probe lifecycle completed; it does not imply the transport passed.

It contains:

```text
probe_terminal_reason
cleanup_status
leak_audit_status
lease_status
safety_status
probe_result_sha256
late_evidence_status
late_evidence_assessment_ref
```

Probe terminal reasons:

```text
COMPLETED
LEASE_ACQUISITION_FAILED
LEASE_LOST
PROVISIONING_FAILED
PROBE_INCOMPLETE
SAFETY_DEADLINE
OPERATOR_ABORT
INTERRUPTED
CLEANUP_INCOMPLETE
LEAK_AUDIT_NOT_CLEAN
EVIDENCE_FINALIZATION_FAILED
```

## Variant-Validation Result Contract

### BR-RUA-038 — Variant-validation status

One variant validation declares exactly one variant and two sequential trials:

1. `CONTROL`;
2. `COMMIT_THEN_TIMEOUT`.

It uses no fabricated `run_id` and makes no BR-RUA-007 or cross-variant conclusion.

Validation summary values:

```text
validation_validity: valid | invalid | indeterminate
implementation_validation_status: verified | failed | indeterminate
```

Status precedence:

1. unresolved, unusable, unsafe, incomplete, non-clean, or indeterminate acceptance conditions produce `indeterminate`;
2. otherwise a trustworthy control preservation `fail` produces `failed`;
3. otherwise control `pass` and a conclusive treatment `pass` or `fail` produce `verified`.

Canonical validation terminal reasons:

```text
COMPLETED
LEASE_ACQUISITION_FAILED
LEASE_LOST
LEASE_RELEASE_FAILED
LEASE_STATE_UNVERIFIED
PROVISIONING_FAILED
VALIDATION_INCOMPLETE
SAFETY_DEADLINE
SAFETY_LIMIT_EXCEEDED
OPERATOR_ABORT
INTERRUPTED
CLEANUP_INCOMPLETE
LEAK_AUDIT_NOT_CLEAN
EVIDENCE_FINALIZATION_FAILED
```

Operational recovery may repair only cleanup, leak-audit, and lease closure. A verifier may derive an effective implementation status from the unchanged original scientific evidence and a valid selected amendment chain. It cannot repair missing scientific evidence, invalid admission or fidelity, manifest drift, original verdicts, a known safety breach, or a missing cryptographic anchor.

### CTR-RUA-004 — Variant-validation verification

The verifier returns at least:

```text
schema_version: 1
record_type: variant_validation_verification
variant_validation_id
validation_summary_ref
original_package_index_sha256
selected_amendment_head_sha256
package_eligibility
declared_implementation_validation_status
effective_implementation_validation_status
effective_cleanup_status
effective_leak_audit_status
effective_lease_status
operational_recovery_applied
effective_status_reasons[]
evidence_refs[]
checked_at
```

Effective operational values include `unverified` where final cleanup, audit, or lease state cannot be established. Package ineligibility, any invalid or indeterminate original scientific condition, any nonrecoverable defect, or any effective operational state other than cleanup `succeeded`, audit `clean`, and lease `released` produces effective implementation status `indeterminate`.

When every scientific and effective operational gate is satisfied, a trustworthy control `fail` produces effective `failed`; control `pass` with a conclusive treatment `pass` or `fail` produces effective `verified`.

## Manifest Lifecycle

### BR-RUA-039 — Rejected admission attempts

Generating an attempt UUID begins admission. If validation, read-only preflight, or synthesis validation fails, the attempt records a structured rejection and preflight journal. It creates no canonical manifest, resource manifest, result, summary, evidence index, or package index, and performs no cloud mutation.

### BR-RUA-040 — Manifest freeze before mutation

Admission resolves and validates:

- execution identities and declared order;
- financial, timing, retry, and safety inputs;
- account and Region;
- source revision and clean-worktree state;
- lockfile and tool versions;
- schemas and schema-file digests;
- coordination dependency identity and schema;
- selected transport qualification and transport-scope snapshot;
- exact frozen deployment assembly;
- conservative resource and spending estimates.

The canonical execution manifest freezes before any mutation. Lease acquisition is the first mutation. Any change to a declared field requires a new execution identity.

Provisioning produces a frozen resource manifest with `succeeded | partial | failed`, every discovered resource, ownership metadata, outputs, and timestamps. Trials may start only after successful provisioning.

Before publication, each trial manifest freezes and references the exact parent and resource-manifest digests.

## Environment Admission Input

### BR-RUA-041 — Environment admission input

The operator-specific environment input is schema-validated and contains exactly one 12-digit account allowlist together with the coordination resource ARN, coordination stack identity, and expected coordination schema version. It contains no credentials, tokens, passwords, or credential-process commands.

Read-only admission resolves the active caller account, requires an exact account match, verifies that coordination identifiers belong to that account and the committed Region, and records the input digest and resolved noncredential values. After manifest freeze, execution uses the frozen values and never reinterprets modified environment input.

## Source and Deployment Provenance

### BR-RUA-042 — Source and deployment provenance

An evidence-bearing execution requires:

- a valid repository rooted at Study 1;
- a resolvable committed `HEAD`;
- a clean index and worktree;
- no nonignored untracked file;
- no unresolved merge, rebase, or cherry-pick state;
- no dirty submodule when submodules exist;
- a present, tracked, unmodified package lockfile.

A detached `HEAD` is acceptable. Ignored evidence, dependency-cache, and synthesis-output directories do not make source dirty. Development tests, local emulation, schema validation, and synthesis may run while dirty, but they cannot produce citable study evidence.

The manifest records commit identity, tree identity, branch when available, clean confirmation, lockfile digest, tool versions, and the deployment-assembly digest.

The implementation builds and synthesizes once into staging, copies the completed assembly into the private evidence package, inventories that copy, freezes the manifest, and deploys only from that exact copy. The canonical inventory sorts normalized relative paths and records each regular file's byte count, file mode, and digest. Symlinks, special files, and container-image assets are rejected by the PoC.

## Evidence Freeze and Amendments

### BR-RUA-043 — Evidence freeze, late evidence and amendments

A trial freezes after settlement, ledger and conditional DLQ capture, oracle evaluation, and evidence indexing, but before DLQ deletion or infrastructure cleanup.

Late evidence never modifies frozen results or original digests. It receives a separate assessment:

```text
none | consistent | contradictory | unverified
```

Normal late monitoring continues for at least 120 seconds after the final trial freeze while the declared consumers remain active. Emergency cleanup may shorten or skip it and records `unverified`.

Post-finalization evidence creates an immutable amendment that references the original package and any preceding amendment. Chains must be linear, digest-valid, cycle-free, and explicitly selected. A contradictory amendment blocks qualification or comparison until another immutable reassessment is explicitly selected; nothing rewrites an earlier package.

### BR-RUA-044 — Package eligibility

Package eligibility is computed only after the original package index exists. It is never frozen inside an original summary.

The verifier returns at least:

```text
package_eligibility: eligible | ineligible
package_ineligibility_reasons[]
original_package_index_sha256
selected_amendment_head_sha256   # null when none is selected
evaluated_at
```

An evidence index excludes itself and the late-evidence area. The final package index hashes every finalized package file except itself and is written last. A probe whose coordination journal remains open through cleanup creates a prefix checkpoint at transport freeze containing the path, prefix byte count, prefix digest, last included event and sequence, and checkpoint time. The evidence index hashes that checkpoint; the final package index hashes the complete coordination journal.

## Coordination Lease

### BR-RUA-045 — Coordination lease

Exactly one owner may hold the Study/account/Region lease:

```text
RUN | TRANSPORT_PROBE | VARIANT_VALIDATION
```

Ownership includes owner kind, owner identity, owner-manifest digest, expiry, and heartbeat. The baseline coordination resource is provisioned separately and is not run-owned.

Heartbeat interval is 30 seconds. The stale boundary is 300 seconds after the last confirmed heartbeat. A first transient failure enters lease uncertainty and blocks new publication. Recovery before staleness may resume scheduling. Ownership mismatch or staleness stops experimental work and begins controlled interruption and emergency cleanup.

Final lease status:

```text
released | recovery_required | unverified
```

TTL expiry never establishes release. Clean original closure conditionally releases the lease before summary and package finalization. Incomplete cleanup or non-clean audit transitions to recovery where possible.

## Safety Contract

### BR-RUA-046 — Safety limits

Admission rejects an account outside the exact allowlist, a Region other than `us-east-1`, unavailable required capabilities, missing ownership strategy, an estimated cost above its ceiling, or an active conflicting lease.

Safety status:

```text
within_limits | breached | unverified
```

Derivation precedence:

```text
breached > unverified > within_limits
```

Each safety check records its boundary, declared limit, observed value when available, result, evidence, and check time.

At the active-time deadline, no new trial starts, active work enters controlled interruption, available evidence is preserved, and emergency cleanup begins. Cleanup continues beyond the total target when necessary; exceeding it is a duration breach rather than permission to abandon cleanup.

The estimated spending ceiling is an admission boundary, not a billing guarantee.

## Attributable Usage Cost

### BR-RUA-047 — Attributable usage cost

The safety boundary covers identifiable run-owned compute, durable execution, messaging, data-store, endpoint, telemetry, artifact-storage, and cleanup usage from first run mutation until cleanup becomes terminal.

It excludes baseline coordination, bootstrap infrastructure, pre-run baseline resources, unrelated account activity, tax, support, credits, refunds, and unassignable shared charges.

Later billing import accepts authoritative usage lines and may correlate them only through exact account, resource identity, activated ownership tag, service, operation, and contained usage interval.

```text
billed_cost_check:
  within_limit | breached | unverified
```

Non-USD or mixed-currency attributable lines, incomplete periods, missing identities, shared charges, or incomplete exports produce `unverified`. The PoC performs no exchange-rate conversion or proportional allocation. Billing evidence is an immutable amendment and remains separate from the deferred scientific cost methodology.

## Cleanup and Leak Audit

### BR-RUA-048 — Normal cleanup

Normal cleanup:

1. completes the late-evidence cutoff;
2. freezes the late assessment;
3. disables consumers and prevents new processing;
4. captures a pre-cleanup operational snapshot;
5. releases held barriers and terminates active executions where necessary;
6. records cleanup-induced transitions separately;
7. captures correlated DLQ evidence;
8. deletes captured run-owned DLQ messages;
9. deletes run-owned stacks and remaining resources;
10. audits every discovery surface;
11. requires stable absence observations;
12. freezes cleanup, summary, and package results.

### BR-RUA-049 — Emergency cleanup

Emergency cleanup stops publishers and consumers immediately, preserves available evidence before mutation when possible, marks unsettled results appropriately, releases barriers, captures DLQ evidence, deletes owned infrastructure, audits leaks, and finalizes when possible.

### BR-RUA-050 — Cleanup ownership

- Every taggable experimental resource carries `suc:project`, `suc:study_id`, `suc:run_id`, `suc:managed_by`, and `suc:expires_at`. Variant-specific resources additionally carry `suc:variant_id`; shared resources omit it. Trial identity remains a data partition and is never a resource tag.
- Direct deletion of a taggable resource requires resource-manifest membership and matching run-specific ownership tags.
- A recorded infrastructure stack may be deleted as the ownership boundary for its managed resources.
- A resource absent from a partial manifest may be deleted only when exact run tags, expected type or deterministic name, and creation after manifest freeze jointly establish ownership.
- Ambiguous ownership is never deleted and is reported as inconclusive.
- A generic project tag alone never authorizes deletion.
- Baseline and bootstrap resources are excluded.

### BR-RUA-051 — Leak audit

Cleanup status:

```text
not_started | running | succeeded | partial | failed
```

Final package status cannot be `not_started` or `running`.

Leak-audit status:

```text
clean | leaks_detected | inconclusive
```

The audit checks the resource manifest, stacks and retained or skipped resources, supported tag-discovery surfaces, required service-native listing APIs, recorded untaggable identifiers, and deterministic resource names. Clean status requires successful discovery and stable absence across every applicable surface for 120 seconds. Any required query failure makes the audit inconclusive.

Cleanup or leak failure never rewrites a frozen trial verdict. It may leave a scientifically intact comparison eligible only when isolation, settlement, and evidence were not compromised.

## Operational Versus Scientific Outcomes

### BR-RUA-052 — Operational and scientific independence

Run execution, preservation, comparison, cleanup, leak audit, lease, evidence integrity, package eligibility, and safety are independent dimensions.

A run may complete its scientific lifecycle when a treatment fails its invariants. A finalized package may faithfully preserve an incomplete or operationally failed execution. Package eligibility proves faithful structure and integrity, not operational or scientific success.

A leak capable of producing later correlated processing or monetary effects compromises settlement and comparison eligibility.

## Implementation Baseline and External Dependencies

### BR-RUA-053 — Platform and transport constraints

*Added in this revision.* These choices are normative for this study rather than
incidental: the serverless execution strategies are the object under test, and
the transport qualification binds to the exact source, dependencies and
configuration it exercised.

The initial implementation baseline is strict TypeScript on Node.js 24, one root npm project with a committed lockfile, AWS CDK v2, AWS SDK for JavaScript v3, the built-in Node test runner, and a local CLI runner.

The controlled provider and journals use durable storage capable of atomic multi-record transitions and strongly consistent trial-scoped reads. The experiment controller consumes inserted caller-timeout events at least once, treats exact duplicates idempotently, and rejects conflicting signals.

The conventional and Durable variants each use a separate FIFO source and dead-letter queue with batch size one, no batching window, one active message group, and identical redrive policy. The declared visibility timeouts differ because the Durable source must remain invisible throughout its longer expected execution.

Direct synchronous function invocation is provisional until the blocking transport probe passes. Provider-client automatic retries are disabled, the immutable provider version is recorded, lower-level timeouts cannot compete with the application deadline, and both transport-level and function-level errors are parsed explicitly.

The complete Durable execution must remain within the direct event-source invocation limit. Inner durable step retries have at-least-once semantics, and an outer source redelivery may start another durable execution. The protocol therefore treats configured attempts as an envelope rather than an absolute physical-call cap.

## Study Completion

### BR-RUA-054 — Canonical study completion

The study is complete when a canonical run, executed in exact order from clean
committed final source and a matching transport qualification, satisfies in its
original immutable package:

```text
comparison_eligibility = eligible
package_eligibility = eligible       # verifier-derived
cleanup_status = succeeded
leak_audit_status = clean
lease_status = released
run_terminal_reason = COMPLETED
```

It also requires all four oracle results, completed BR-RUA-007 evaluation,
verified evidence integrity, no contradictory amendment, no known safety breach,
and no remaining owned resource. Operational recovery may make another run safe
but cannot make an originally unclean run complete the study.

### BR-RUA-055 — The oracle is final before cloud evidence

*Approved in this revision. v1.0 gave this rule in the Milestone 1 plan. It is a
rule of scientific integrity, not a sequence note. If the oracle changes after it
sees the evidence, that evidence is compromised.*

Every verdict-changing rule must be implemented before cloud study evidence is
collected.

## Threats to Validity and Limitations

1. CA-1 is an explicit clock-alignment assumption without a managed-function clock-accuracy guarantee.
2. The controlled provider reproduces the relevant causal and monetary boundary, not every production processor behavior.
3. Provider idempotency and reconciliation are excluded, intentionally exposing architectural retries.
4. At-least-once delivery can produce additional physical calls beyond the configured path.
5. Fixed order and one seed support protocol validation, not latency, cost, or statistical comparison.
6. Two variants cannot support conclusions about all serverless architectures.
7. SHA-256 detects changes relative to trusted digests but does not prove authorship.
8. Delayed or incomplete billing attribution may leave safety unverified.
9. Variant-validation evidence is non-comparative and cannot substitute for the canonical four-cell run.
10. A private raw package may contain environment identifiers; any public redaction is a separately derived artifact.

## Non-Goals

- Move real money or integrate with a production payment provider.
- Add provider idempotency, reconciliation, compensation, or a provider-side call cap.
- Support partial refunds, multiple logical refund requests, reversals, chargebacks, or pending provider transactions.
- Implement a third variant or second treatment in the vertical PoC.
- Collect statistical samples or claim performance, latency, cost, or architectural superiority from the PoC.
- Add an agentic decision lane.
- Implement the final scientific cost-per-correct-completion methodology.
- Build a generic experiment plugin system, scenario DSL, multi-study runner, or parent-level shared library.
- Treat a variant validation as a canonical run or comparison.
- Infer exactly-once delivery from infrastructure behavior.
- Use optional telemetry to replace durable causal or ledger evidence.
- Mutate a frozen result or package when late evidence, recovery, or billing data arrives.
- Add Docker image assets to the PoC deployment assembly.
- Produce publication or redaction artifacts as part of the immutable raw evidence package.

## Open Questions

Direct synchronous invocation remains provisional by design and is resolved empirically through the blocking transport-qualification gate (BR-RUA-026) rather than by an open specification decision.

### OQ-RUA-001 — Retrieval date of each external source

*Closed in this revision. The Retrieved column of External Sources gives the date of each read.*

The sources below carry no retrieval date. The behavior relied upon can change, and Lambda Durable Functions is recent; record the date each source was read.

### OQ-RUA-002 — Source for the SQS event-source mapping

*Closed in this revision. External Sources gives the sources for the SQS event-source mapping.*

The message-source protocol (BR-RUA-020) relies on FIFO ordering, visibility timeout and redrive with `maxReceiveCount`, but no source for the SQS event-source mapping is cited.

### OQ-RUA-003 — Operator CLI contract

The spec names "a local CLI runner" but declares no commands, inputs, outputs
or exit codes, and the study operator's QA contract (`specs/qa/study-operator/`)
points to this interface. Proposal: declare it as CTR-RUA-007, with each
command's inputs, its structured JSON output and its exit codes.

## External Sources

These sources constrain the implementation protocol; they do not define the refund business invariants. *The second column was added in this revision, derived from how this spec uses each source.* *This revision adds the Retrieved column and the last six rows (OQ-RUA-001, OQ-RUA-002).*

| Source | Behavior this study relies on | Retrieved |
|---|---|---|
| [AWS Lambda Invoke API](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html) | Synchronous direct invocation and its transport-level and function-level error surfaces | 2026-10-05, 2026-10-07 |
| [Lambda examples using AWS SDK for JavaScript v3](https://docs.aws.amazon.com/lambda/latest/dg/example_lambda_Invoke_section.html) | Invoking through the SDK client, whose automatic retries can be disabled | 2026-10-07 |
| [Lambda with DynamoDB Streams](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html) | At-least-once consumption of inserted records, from the earliest available position | 2026-10-05, 2026-10-07 |
| [DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) | Strongly consistent reads for the complete ledger snapshot | 2026-10-05, 2026-10-07 |
| [Lambda Durable Functions getting started](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started.html) | The durable execution model of the Durable variant | 2026-10-05, 2026-10-07 |
| [Lambda Durable Functions retries](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html) | Step retries with at-least-once semantics | 2026-10-05, 2026-10-07 |
| [Durable execution idempotency and event-source mappings](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html) | An outer source redelivery may start a new durable execution | 2026-10-05, 2026-10-07 |
| [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) | Synthesizing and deploying the frozen assembly | 2026-10-07 |
| [AWS account identifiers](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-identifiers.html) | The 12-digit account format of the allowlist | 2026-10-05, 2026-10-07 |
| [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html) | Read-only resolution of the active caller account at admission | 2026-10-05, 2026-10-07 |
| [AWS Cost Explorer](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html) | Usage data behind attributable-cost amendments | 2026-10-07 |
| [AWS CUR line-item details](https://docs.aws.amazon.com/cur/latest/userguide/Lineitem-columns.html) | Authoritative usage lines and their correlation fields | 2026-10-07 |
| [Lambda execution environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) | Execution-environment behavior relevant to CA-1 | 2026-10-07 |
| [Amazon Time Sync Service for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html) | Background for CA-1; not a guarantee for Lambda | 2026-10-07 |
| [AWS SDKs and Tools: retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html) | A max-attempts value of 1 stops the automatic retries of an SDK client | 2026-10-07 |
| [CUR 2.0 line-item columns](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2-line-item.html) | The CUR 2.0 names of the line-item columns that the billing import reads | 2026-10-07 |
| [Lambda with Amazon SQS: scaling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html) | Lambda receives the messages of one FIFO message group in sequence. It does all retries of a message before it receives more messages of that group | 2026-10-07 |
| [Lambda with Amazon SQS: configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html) | If the function does not complete a batch, its messages return to the queue and become visible after the visibility timeout. The function timeout must not be more than the visibility timeout | 2026-10-07 |
| [Amazon SQS FIFO message groups](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html) | Amazon SQS does not return more messages of a message group until the received messages are deleted or visible again | 2026-10-07 |
| [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) | The redrive policy moves a message to the dead-letter queue after `maxReceiveCount` receives | 2026-10-07 |

Retrieval notes:

- The Retrieved column gives the date of each read. 2026-10-05 is the date that the research of the implementation recorded.
- 2026-10-07 is the date of a second read for OQ-RUA-001 and OQ-RUA-002. A row with only that date has no recorded earlier read.
- The SDK example page shows the call, but it does not give the retry setting. The retry-behavior row gives that setting.
- The retry-behavior page tells that its 2026 retry behavior starts only with an opt-in setting.
- The Durable retries page gives step retries. The idempotency page gives the at-least-once semantics of a step.
- The CUR line-item page uses the legacy column names. The CUR 2.0 row gives the column names that the billing import reads.
- The dead-letter queue page also tells that a dead-letter queue can break the sequence of a FIFO queue. BR-RUA-020 has one active message group for each trial. This warning has no effect on Study 1, because each trial publishes exactly one message in its own message group.

## Former identifiers

This revision replaces the unprefixed identifiers of Specification v1.0. Code,
golden fixtures and serialized `rule_results` or `condition_results` that still
use a former identifier migrate in the same change.

| Former | Now |
|---|---|
| BR-1 … BR-9 | BR-RUA-001 … BR-RUA-009 |
| IR-1 | INV-RUA-001 |
| TQ-1 … TQ-6 | BR-RUA-010 … BR-RUA-015 |
| AC-1 … AC-27 | AC-RUA-001 … AC-RUA-027; compound criteria were split, and their second scenarios are AC-RUA-028 … AC-RUA-038 |
| CA-1 | Unchanged: it is a serialized assumption identifier, not a rule |
