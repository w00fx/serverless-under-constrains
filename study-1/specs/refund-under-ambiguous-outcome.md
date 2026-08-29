# Study 1: Evaluate Refund-Invariant Preservation Under Ambiguous Outcomes

Status: Specification v1.0  
Capability: **Evaluate refund-invariant preservation under ambiguous outcomes.**  
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

The implementation begins with Milestone 0 and proceeds through the milestones defined in this specification.

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

Each trial contains exactly:

- one payment;
- one approved full-refund request;
- an initially empty trial-scoped provider ledger.

The provider ledger stores only immutable `SUCCEEDED` transactions. Timed-out, failed, and rejected calls belong to journals rather than the ledger.

Partial refunds, multiple logical requests, pending or failed provider transactions, reversals, chargebacks, reconciliation, compensation, and provider-side idempotency are outside the PoC.

## Business Rules

The rules in this section are protocol-defined for Study 1 version 1. They are not derived from an external regulatory source.

### BR-1: One Effect per Request

When a valid isolated trial settles, the provider ledger must contain exactly one successful transaction associated with its declared `refund_request_id`.

```text
count(successful_transactions where refund_request_id = R) = 1
```

### BR-2: Payment Limit

While the trial payment exists, the arbitrary-precision sum of successful transactions associated with it must not exceed its captured amount.

```text
sum(successful_transactions.amount_minor where payment_id = P)
  <= payment.captured_amount_minor
```

### BR-3: Stable Logical Identity

Whenever the architecture retries a logical request, every physical attempt must preserve the original `refund_request_id`.

```text
distinct(attempt.refund_request_id for attempts of logical request R) = {R}
```

### BR-4: Unknown Outcome

Whenever an attempt is dispatched and then times out, or fails without authoritative proof that it was not dispatched or was rejected before commit, the request's effect knowledge must become `UNKNOWN`.

```text
TIMED_OUT                              -> UNKNOWN
FAILED + DISPATCHED                   -> UNKNOWN
FAILED + UNKNOWN dispatch             -> UNKNOWN
UNKNOWN + any later attempt outcome   -> UNKNOWN
```

`UNKNOWN` is absorbing within this PoC. A later successful response proves only the later effect and does not resolve an earlier ambiguous attempt.

### BR-5: Independent Oracle

When the oracle evaluates monetary rules, it must use the complete strongly consistent trial-scoped provider-ledger snapshot. Variant state, logs, metrics, traces, and derived attempt projections may explain an observation but may not replace the ledger.

```text
monetary_evidence_source = complete_strong_ledger_snapshot
```

### BR-6: Trial Classification

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

### BR-7: Equal Treatment

When two variants are compared, both must receive equal declared business inputs and treatment parameters except for differences explicitly declared as part of the variants' execution strategies.

```text
comparison_eligibility = eligible
only if every equality projection passes and no undeclared difference exists
```

A failed invariant does not make a comparison ineligible. Unequal or undeclared protocol conditions do.

### BR-8: Traceability

When a result is evaluated, every verdict-critical input, attempt, provider request, provider call, transaction, observation, manifest, and causal predecessor must be correlatable to the active immutable execution identity.

BR-8 delegates physical identity uniqueness to IR-1 rather than duplicating it.

```text
all(verdict_critical_records have the applicable execution identity)
and all(manifest references resolve to the frozen digest)
and all(required evidence_refs resolve to exact indexed bytes)
and all(required causation_event_ids resolve)
and IR-1 is verified
```

### BR-9: Exact Authorized Effect

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

One transaction with an incorrect amount, currency, request identity, or payment identity fails BR-9 even when BR-1's count equals one. Any additional successful transaction associated with the isolated trial also fails BR-9.

## Integrity Rule

### IR-1: Physical Identity Integrity

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
- Invalid or unverified IR-1 makes the top-level preservation verdict `indeterminate` while independently proven monetary observations remain reported.

IR-1 is a protocol-validity gate, not a refund business rule.

## Admission Rules

Both `captured_amount_minor` and `approved_amount_minor` must:

- be positive integers;
- be no greater than `9007199254740991`;
- use `BRL`;
- be equal because only full refunds are supported.

Every required identifier must be nonempty after whitespace trimming.

Admission rejects zero, negative, fractional, unsafe, unequal, non-BRL, mismatched-currency, or empty-identity inputs. A rejected attempt records its rejection and read-only preflight evidence, creates no canonical manifest or oracle result, and performs no cloud mutation.

## Controlled Provider Contract

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

The canonical run contains exactly four sequential trials:

1. conventional `CONTROL`;
2. Durable `CONTROL`;
3. conventional `COMMIT_THEN_TIMEOUT`;
4. Durable `COMMIT_THEN_TIMEOUT`.

Every trial receives a fresh `trial_id` and fresh state partitions. Partitions are asserted absent before execution and are never reset or reused. Fixed business fixture identifiers may be reused because every lookup and uniqueness boundary includes the trial identity.

Seed `1` is recorded for future deterministic scheduling. The PoC order is explicit and must not be attributed to the seed unless an implemented deterministic scheduling algorithm actually derives it.

The PoC has no batch, repetition index, statistical-sampling dimension, or randomized collection.

## Message-Source Protocol

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

After the durable dispatch transition succeeds, the caller captures a source-local monotonic origin, starts the three-second application timer, and invokes transport immediately. One in-process arbiter permits only the timer or transport settlement to win. The timer produces `TIMED_OUT` only when at least three seconds have elapsed, transport remains unsettled, the timer wins, transport abort is requested, and `caller_timeout_recorded` is durably appended. An abort error alone never proves a timeout.

The timeout event records monotonic elapsed nanoseconds, its monotonic origin event, diagnostic dispatch and deadline timestamps, timer-fire time, abort-request time, timeout-record time, and the dispatch event as a causal predecessor. Abort occurs before the durable timeout write so the provider remains behind the barrier until the controller receives that write.

Terminality applies across every configured retry layer. A failed delivery or exhausted inner execution is not request-level `RETRIES_EXHAUSTED` while an upstream layer can still redeliver.

## Scenario Integrity and Treatment Fidelity

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

CA-1 is a study assumption, not a provider guarantee. Results must describe TQ-1 as empirical ordering under the declared PoC clock-alignment assumption and must not describe it as formal happened-before proof or guaranteed distributed-clock accuracy.

## Transport Qualification Conditions

The selected transport must pass a distinct real-cloud probe before any study run or variant validation consumes it.

### TQ-1: Commit Before Timer

The provider transaction must be durably committed before the caller timer wins.

```text
provider.committed_at < caller.timer_fired_at
ordering_basis = cross_source_wall_clock
clock_assumption_refs = [CA-1]
```

Reversed timestamps fail. Equal or missing timestamps are indeterminate. The signed observed timestamp difference is reported but is not interpreted as a clock-error bound.

### TQ-2: Application Timeout

The application-owned timer must win after at least three seconds of source-local monotonic elapsed time while the transport promise remains unsettled, abort transport, and cause the durable `caller_timeout_recorded` event.

### TQ-3: Continued Provider Execution

The provider must continue executing after the caller aborts.

### TQ-4: Causal Join and Observation

The controller signal must be immediately caused by both provider commit and caller timeout, and the provider must subsequently observe that signal.

### TQ-5: Controlled Release

The provider must release only after timeout observation, and no safety release may occur.

### TQ-6: No Caller-Observed Success

The caller must never observe a successful provider response for the targeted attempt.

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

One explicitly selected immutable probe qualifies only the transport implementation scope it actually exercised. The qualification consists of:

- a committed scope policy declaring critical entry points, conservative source roots, configuration projections, runtime properties, and relevant dependencies;
- a frozen snapshot containing the policy digest, resolved paths, transitive production dependency closure, exact source digests, normalized provider and controller configuration, resolved dependency versions, and timing values;
- the selected probe identity, original package-index digest, explicit amendment-head digest when present, and scope-snapshot digest.

The complete dispatch, timeout, abort, and provider-call behavior belongs to one shared provider-client contract. Variants may invoke it but may not reimplement or override it.

Admission recomputes the selected scope against current committed source. Any scoped drift rejects the attempt before manifest freeze and requires a new transport probe. Unrelated oracle, reporting, or orchestration changes do not require a new probe. A later probe never supersedes an earlier probe unless explicitly selected.

## Trial Validity and Verdicts

Applicable validity gates include:

- BR-5 independent oracle;
- BR-8 traceability;
- IR-1 identity integrity;
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

A canonical four-cell comparison is `eligible` only when:

- all four declared trials have oracle results;
- every trial-validity gate is valid;
- both controls have verified control integrity;
- both treatment trials have verified treatment fidelity;
- BR-7 equality passes;
- evidence integrity is verified;
- late evidence is `none` or `consistent`;
- no effective contradictory amendment exists.

Both `pass` and `fail` are comparable outcomes. Invariant failure does not independently make comparison ineligible. Cleanup failure, leak detection, or safety breach remains a separate operational qualification unless it compromised trial isolation, evidence completeness, settlement, or the observation window.

## Settlement

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

### Financial Fixture

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

### Timing and Retry Inputs

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

### Canonical Run Safety

| Input | Value |
|---|---:|
| Region | `us-east-1` |
| Maximum active experiment time | 4,500 seconds |
| Reserved cleanup window | 900 seconds |
| Total target | 5,400 seconds |
| Estimated attributable-usage ceiling | USD 5.00 |
| Concurrent owners per Study/account/Region | 1 |

### Transport-Probe Safety

| Input | Value |
|---|---:|
| Region | `us-east-1` |
| Active probe time | 600 seconds |
| Reserved cleanup | 600 seconds |
| Total target | 1,200 seconds |
| Estimated attributable-usage ceiling | USD 1.00 |
| Stabilization interval | 120 seconds |

### Variant-Validation Safety

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

### AC-1: Normal Case

- **Given** the valid reference payment, approved request, and `CONTROL`
- **When** either variant completes and the trial settles
- **Then** the ledger contains exactly the authorized successful transaction
- **And** BR-1, BR-2, and BR-9 pass
- **And** the oracle returns `pass`
- **And** successful terminal processing produces `correct_completion = true`.

### AC-2: Commit Followed by Timeout

- **Given** an admitted treatment trial with the first accepted provider call targeted
- **When** the provider atomically commits and the application timer wins
- **Then** TQ-1 through TQ-6 are evaluated from frozen evidence
- **And** verified fidelity identifies CA-1 and `causal_plus_cross_source_clock_assumption`
- **And** the result does not claim formal happened-before proof or an AWS clock guarantee.

### AC-3: Observed Result After a Retry

- **Given** a first attempt with `TIMED_OUT` and effect knowledge `UNKNOWN`
- **When** the architecture executes its configured retry path
- **Then** every attempt retains the logical refund identity
- **And** aggregate effect knowledge remains `UNKNOWN`
- **And** every provider call and transaction is preserved
- **And** the oracle returns the evidence-derived preservation verdict.

### AC-4: Duplicate Detection

- **Given** a complete ledger snapshot with two successful full-refund transactions
- **When** the oracle evaluates a valid settled trial
- **Then** BR-1, BR-2, and BR-9 fail
- **And** preservation is `fail`
- **And** the trial remains scientifically valid.

### AC-5: Missing Effect Detection

- **Given** an approved request with zero successful transactions in a complete settled ledger
- **When** the oracle evaluates the valid trial
- **Then** BR-1 and BR-9 fail
- **And** preservation is `fail`.

### AC-6: Authoritative Source

- **Given** variant state claims success but the complete ledger lacks the authorized transaction
- **When** the oracle evaluates the trial
- **Then** the ledger controls the monetary result
- **And** variant state cannot override it.

### AC-7: Insufficient Evidence

- **Given** ledger access is incomplete, settlement is not established, or verdict-critical evidence is missing
- **When** the oracle evaluates the trial
- **Then** affected rule checks are `indeterminate`
- **And** preservation is `indeterminate`
- **And** structured reasons identify the missing evidence.

### AC-8: Controlled Repetition

- **Given** a valid execution definition
- **When** admission succeeds
- **Then** identities, order, inputs, timing, safety, source revision, qualification, schemas, and dependencies freeze before mutation
- **And** every result references those exact frozen bytes.

### AC-9: Equality Between Variants

- **Given** all four canonical trials
- **When** the runner evaluates BR-7
- **Then** declared common inputs and treatment parameters compare equal
- **And** only declared variant differences remain
- **And** unequal undeclared conditions make comparison ineligible without erasing individual verdicts.

### AC-10: Minimum Evidence Package

- **Given** a trial reaches evidence freeze
- **When** its evidence index is generated
- **Then** every applicable verdict-critical manifest, input, journal, provider event, ledger snapshot, queue observation, conditional DLQ snapshot, and authoritative execution record is indexed by exact bytes
- **And** derived artifacts remain distinguishable from primary evidence.

### AC-11: Verifiable Cleanup

- **Given** an execution succeeds, fails, becomes indeterminate, or is interrupted
- **When** cleanup runs one or more times
- **Then** deletion occurs only for conservatively proven owned resources
- **And** already absent owned resources are successful deletions
- **And** leak-audit results preserve leaks and inconclusive ownership rather than deleting ambiguously owned resources.

### AC-12: Result Does Not Follow the Hypothesis

- **Given** observed evidence contradicts the initial hypothesis
- **When** the oracle and summaries are produced
- **Then** the calculated observations remain unchanged and included
- **And** no trial is altered or excluded to support the hypothesis.

### AC-13: Exact-Effect Mismatch

- **Given** exactly one successful transaction with an incorrect amount, currency, request identity, or payment identity
- **When** the oracle evaluates a valid trial
- **Then** BR-1 may pass its count check
- **But** BR-9 fails
- **And** preservation is `fail`.

### AC-14: Pre-Execution Rejection

- **Given** invalid financial input, identity, source provenance, account, Region, safety, qualification, or coordination configuration
- **When** read-only admission runs
- **Then** a structured rejection and preflight journal are preserved
- **And** no canonical manifest, trial, oracle result, package index, or cloud mutation is created.

### AC-15: Dispatch Classification

- **Given** an attempt fails before dispatch
- **When** a conditional durable transition proves it remained pre-dispatch
- **Then** dispatch state is `NOT_DISPATCHED`
- **And** a first action retains `NOT_ATTEMPTED`
- **But Given** the dispatch boundary was crossed or cannot be located
- **Then** the attempt is `DISPATCHED` or `UNKNOWN` and no absence observation may prove non-dispatch.

### AC-16: Unknown Knowledge Is Absorbing

- **Given** any attempt establishes `UNKNOWN`
- **When** a later attempt succeeds, fails, or is rejected
- **Then** aggregate effect knowledge remains `UNKNOWN`
- **And** processing may independently finish.

### AC-17: Physical Identity Integrity

- **Given** caller identity reuse, missing physical identity evidence, or provider-generated identity collision
- **When** IR-1 and evidence integrity are evaluated
- **Then** the appropriate integrity gate is invalid or unverified
- **And** preservation is `indeterminate`
- **And** independently proven monetary observations remain reported.

### AC-18: Control Integrity

- **Given** a `CONTROL` trial
- **When** treatment is never armed or consumed and every accepted call returns before its deadline
- **Then** control integrity is `verified`
- **But When** treatment or an uncontrolled timeout is proven
- **Then** control integrity is `invalid` and preservation is `indeterminate`.

### AC-19: Consumer Manifest Mismatch

- **Given** a published message whose execution identity or trial-manifest digest does not match the active frozen trial
- **When** a consumer validates it
- **Then** the consumer records `MESSAGE_REJECTED`
- **And** makes no provider call
- **And** effect knowledge remains `NOT_ATTEMPTED`
- **And** the started trial is `indeterminate`.

### AC-20: Settlement and Late Evidence

- **Given** correlated activity appears before evidence freeze
- **When** settlement is being observed
- **Then** stabilization restarts
- **But Given** correlated activity appears after freeze
- **Then** it is preserved as late evidence
- **And** the frozen result and original digests remain unchanged
- **And** contradictory late evidence blocks qualification or comparison as applicable.

### AC-21: Transport Qualification

- **Given** clean admitted probe inputs and one isolated provider call
- **When** the real-cloud qualification executes
- **Then** a `pass` requires every TQ condition to pass, valid probe fidelity, verified evidence, expected cardinality, and no safety release
- **And** conclusive violation produces `fail`
- **And** insufficient evidence produces `indeterminate`
- **And** only a passing usable probe may be selected by later executions.

### AC-22: Immutable Package Verification

- **Given** an original package index and an explicitly selected amendment head
- **When** the package verifier runs
- **Then** it validates every indexed byte, chain parent, sequence, reference, and known descendant
- **And** returns `eligible` only for a complete noncontradictory selected chain
- **And** package eligibility does not imply preservation, implementation, comparison, or milestone success.

### AC-23: Lease Uncertainty and Loss

- **Given** a failed lease heartbeat
- **When** ownership remains unconfirmed
- **Then** new publication stops immediately
- **And** confirmed ownership may resume only before the stale boundary
- **And** ownership mismatch or staleness interrupts active work and begins emergency cleanup
- **And** TTL expiry alone never proves release.

### AC-24: Attributable-Cost Amendment

- **Given** a later billing export
- **When** exact resource, ownership, operation, account, currency, and usage-window correlation is possible
- **Then** attributable USD usage is compared with the declared ceiling
- **But When** attribution is incomplete or any attributable line is non-USD
- **Then** billed-cost safety is `unverified`
- **And** no proportional allocation or exchange-rate conversion occurs.

### AC-25: Variant Validation

- **Given** one variant's sequential control and treatment validation trials
- **When** both yield trustworthy conclusive evidence and operational acceptance gates are satisfied
- **Then** control `pass` plus treatment `pass` or `fail` produces implementation-validation `verified`
- **And** a trustworthy control `fail` produces implementation-validation `failed`
- **And** indeterminate scientific or operational acceptance produces implementation-validation `indeterminate`
- **And** the package makes no cross-variant claim.

### AC-26: Operational Recovery of a Variant Validation

- **Given** scientifically valid frozen validation evidence with incomplete cleanup, audit, or lease closure
- **When** a valid amendment chain repairs only those operational conditions
- **Then** a verifier may derive effective cleanup `succeeded`, audit `clean`, lease `released`, and implementation status `verified` or `failed`
- **And** the original summary and scientific results remain unchanged
- **And** missing or invalid scientific evidence cannot be repaired operationally.

### AC-27: Canonical Four-Cell Completion

- **Given** a clean-source canonical run with all four settled trial results
- **When** BR-7 and all validity, integrity, late-evidence, package, cleanup, audit, lease, and safety checks complete
- **Then** Milestone 4 requires `comparison_eligibility = eligible`
- **And** original cleanup is `succeeded`, audit is `clean`, and lease is `released`
- **And** treatment `fail` results remain admissible observations
- **And** an operationally recovered but originally unclean run cannot complete Milestone 4.

## Serialization Contract

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

### Payment

```json
{
  "schema_version": 1,
  "record_type": "payment",
  "payment_id": "pay-poc-001",
  "captured_amount_minor": 10000,
  "currency": "BRL"
}
```

### Approved Decision

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

### Published Trial Message

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

One variant validation declares exactly one variant and two sequential trials:

1. `CONTROL`;
2. `COMMIT_THEN_TIMEOUT`.

It uses no fabricated `run_id` and makes no BR-7 or cross-variant conclusion.

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

### Rejected Attempts

Generating an attempt UUID begins admission. If validation, read-only preflight, or synthesis validation fails, the attempt records a structured rejection and preflight journal. It creates no canonical manifest, resource manifest, result, summary, evidence index, or package index, and performs no cloud mutation.

### Canonical Admission

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

The operator-specific environment input is schema-validated and contains exactly one 12-digit account allowlist together with the coordination resource ARN, coordination stack identity, and expected coordination schema version. It contains no credentials, tokens, passwords, or credential-process commands.

Read-only admission resolves the active caller account, requires an exact account match, verifies that coordination identifiers belong to that account and the committed Region, and records the input digest and resolved noncredential values. After manifest freeze, execution uses the frozen values and never reinterprets modified environment input.

## Source and Deployment Provenance

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

A trial freezes after settlement, ledger and conditional DLQ capture, oracle evaluation, and evidence indexing, but before DLQ deletion or infrastructure cleanup.

Late evidence never modifies frozen results or original digests. It receives a separate assessment:

```text
none | consistent | contradictory | unverified
```

Normal late monitoring continues for at least 120 seconds after the final trial freeze while the declared consumers remain active. Emergency cleanup may shorten or skip it and records `unverified`.

Post-finalization evidence creates an immutable amendment that references the original package and any preceding amendment. Chains must be linear, digest-valid, cycle-free, and explicitly selected. A contradictory amendment blocks qualification or comparison until another immutable reassessment is explicitly selected; nothing rewrites an earlier package.

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

The safety boundary covers identifiable run-owned compute, durable execution, messaging, data-store, endpoint, telemetry, artifact-storage, and cleanup usage from first run mutation until cleanup becomes terminal.

It excludes baseline coordination, bootstrap infrastructure, pre-run baseline resources, unrelated account activity, tax, support, credits, refunds, and unassignable shared charges.

Later billing import accepts authoritative usage lines and may correlate them only through exact account, resource identity, activated ownership tag, service, operation, and contained usage interval.

```text
billed_cost_check:
  within_limit | breached | unverified
```

Non-USD or mixed-currency attributable lines, incomplete periods, missing identities, shared charges, or incomplete exports produce `unverified`. The PoC performs no exchange-rate conversion or proportional allocation. Billing evidence is an immutable amendment and remains separate from the deferred scientific cost methodology.

## Cleanup and Leak Audit

### Normal Cleanup

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

### Emergency Cleanup

Emergency cleanup stops publishers and consumers immediately, preserves available evidence before mutation when possible, marks unsettled results appropriately, releases barriers, captures DLQ evidence, deletes owned infrastructure, audits leaks, and finalizes when possible.

### Ownership Rules

- Every taggable experimental resource carries `suc:project`, `suc:study_id`, `suc:run_id`, `suc:managed_by`, and `suc:expires_at`. Variant-specific resources additionally carry `suc:variant_id`; shared resources omit it. Trial identity remains a data partition and is never a resource tag.
- Direct deletion of a taggable resource requires resource-manifest membership and matching run-specific ownership tags.
- A recorded infrastructure stack may be deleted as the ownership boundary for its managed resources.
- A resource absent from a partial manifest may be deleted only when exact run tags, expected type or deterministic name, and creation after manifest freeze jointly establish ownership.
- Ambiguous ownership is never deleted and is reported as inconclusive.
- A generic project tag alone never authorizes deletion.
- Baseline and bootstrap resources are excluded.

### Leak Audit

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

Run execution, preservation, comparison, cleanup, leak audit, lease, evidence integrity, package eligibility, and safety are independent dimensions.

A run may complete its scientific lifecycle when a treatment fails its invariants. A finalized package may faithfully preserve an incomplete or operationally failed execution. Package eligibility proves faithful structure and integrity, not operational or scientific success.

A leak capable of producing later correlated processing or monetary effects compromises settlement and comparison eligibility.

## Implementation Baseline and External Dependencies

The initial implementation baseline is strict TypeScript on Node.js 24, one root npm project with a committed lockfile, AWS CDK v2, AWS SDK for JavaScript v3, the built-in Node test runner, and a local CLI runner.

The controlled provider and journals use durable storage capable of atomic multi-record transitions and strongly consistent trial-scoped reads. The experiment controller consumes inserted caller-timeout events at least once, treats exact duplicates idempotently, and rejects conflicting signals.

The conventional and Durable variants each use a separate FIFO source and dead-letter queue with batch size one, no batching window, one active message group, and identical redrive policy. The declared visibility timeouts differ because the Durable source must remain invisible throughout its longer expected execution.

Direct synchronous function invocation is provisional until the blocking transport probe passes. Provider-client automatic retries are disabled, the immutable provider version is recorded, lower-level timeouts cannot compete with the application deadline, and both transport-level and function-level errors are parsed explicitly.

The complete Durable execution must remain within the direct event-source invocation limit. Inner durable step retries have at-least-once semantics, and an outer source redelivery may start another durable execution. The protocol therefore treats configured attempts as an envelope rather than an absolute physical-call cap.

## Delivery Milestones

### Milestone 0: Establish the Protocol Foundation and Qualify the Treatment Transport

Objective: demonstrate that the selected transport produces the declared ambiguous outcome in real AWS and preserves a complete, valid, immutable, safely closed qualification package.

Internal checkpoints:

- **M0-A — Repository and deterministic local contracts:** repository, toolchain, probe schemas, canonical serialization, identities, time, sequencing, causality, hashing, validation, and golden tests; no cloud mutation.
- **M0-B — Treatment mechanism:** shared provider client, deadline arbiter, provider, ledger, journals, treatment state, controller, and TQ derivation; no evidence-bearing probe yet.
- **M0-C — Safe cloud lifecycle:** baseline coordination entry point, lease, probe admission, infrastructure, exact assembly, cleanup, leak audit, and package lifecycle; coordination bootstrap remains deliberate operator action.
- **M0-D — Real-cloud qualification:** clean committed source, admitted probe, real execution, evidence freeze, cleanup, clean audit, released lease, package verification, and frozen transport scope.

Milestone 0 completes only when one selected probe has every TQ condition `pass`, valid probe and treatment fidelity, verified evidence, noncontradictory late evidence, clean effective operational closure, no known safety breach, a verified package, and a reusable transport-scope snapshot.

SQS variant sources, complete study contracts, the preservation oracle, and four study trials remain outside Milestone 0.

### Milestone 1: Offline Oracle and Canonical Study Contracts

Given immutable synthetic evidence, one local command validates the package, evaluates every applicable BR and IR-1 check, derives trial and run results, and verifies the resulting package. Golden cases cover exact effect, duplicates, missing effect, wrong effect, identity conflict, unknown outcome, incomplete ledger, invalid fidelity, missing causality, digest failure, and unsettled environment.

Every verdict-changing rule must be implemented before cloud study evidence is collected.

### Milestone 2: Conventional Variant Vertical Validation

One immutable non-comparative validation executes conventional `CONTROL` followed by conventional treatment using the frozen oracle contract. A matching transport qualification is mandatory. Effective implementation validation may rely on an amendment that repairs only cleanup, audit, or lease closure.

### Milestone 3: Durable Variant Vertical Validation

One separate immutable non-comparative validation executes Durable `CONTROL` followed by Durable treatment, proves the declared durable retry and execution evidence, and regression-checks the conventional path. It uses the same provider client, fixture, provider, treatment point, oracle, and evidence contracts.

### Milestone 4: Canonical Four-Cell Study Run

The first comparison-eligible run executes all four cells in exact order from clean committed final source and a matching transport qualification.

Milestone 4 requires, in the original immutable package:

```text
comparison_eligibility = eligible
package_eligibility = eligible       # verifier-derived
cleanup_status = succeeded
leak_audit_status = clean
lease_status = released
run_terminal_reason = COMPLETED
```

It also requires all four oracle results, completed BR-7 evaluation, verified evidence integrity, no contradictory amendment, no known safety breach, and no remaining owned resource. Operational recovery may make another run safe but cannot make an originally unclean run complete Milestone 4.

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

None. Direct synchronous invocation remains provisional by design and is resolved empirically through the blocking transport-qualification gate rather than by an open specification decision.

## External Sources

These sources constrain the implementation protocol; they do not define the refund business invariants.

- [AWS Lambda Invoke API](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)
- [Lambda examples using AWS SDK for JavaScript v3](https://docs.aws.amazon.com/lambda/latest/dg/example_lambda_Invoke_section.html)
- [Lambda with DynamoDB Streams](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html)
- [DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)
- [Lambda Durable Functions getting started](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started.html)
- [Lambda Durable Functions retries](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html)
- [Durable execution idempotency and event-source mappings](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)
- [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html)
- [AWS account identifiers](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-identifiers.html)
- [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)
- [AWS Cost Explorer](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html)
- [AWS CUR line-item details](https://docs.aws.amazon.com/cur/latest/userguide/Lineitem-columns.html)
- [Lambda execution environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
- [Amazon Time Sync Service for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html)
