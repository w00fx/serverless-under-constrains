// The fixed transport settings of the shared provider client (BR-RUA-028, BR-RUA-053; design
// §5.3 `provider-client/`, §9.4, §9.13 cases 1 and 3). They are code constants, never
// environment variables, so no variant can override them:
// - the application deadline is 3 s of source-local monotonic time (BR-RUA-011, BR-RUA-023);
// - `maxAttempts: 1` overrides `AWS_MAX_ATTEMPTS` and the SDK retry strategy, so a timed-out
//   Invoke is never re-sent as a hidden second provider call (RK-05);
// - every HTTP-level timeout is 0 (disabled) and `throwOnRequestTimeout` is false, so no
//   lower-level timeout can preempt the 3 s deadline; keep-alive reuses the TLS connection (RK-01).

/**
 * The attempt timings, in nanoseconds:
 * - `deadline_ns`: the application deadline (BR-RUA-011: "at least three seconds");
 * - `late_settlement_grace_ns`: how long after a durable timeout the client waits for the
 *   aborted transport to settle before it records the outcome without a
 *   `transport_settled_after_timeout` (D-26, RK-04). An abort through the SDK HTTP handler
 *   settles at once, so the grace only bounds a transport that ignores the abort; 3 s + 2 s
 *   leaves at least 5 s of the 10 s caller invocation timeout (OR-RUA-002) for the outcome
 *   append and the variant's request state (WP-06 review round 1).
 */
export const PROVIDER_CLIENT_TIMING = {
  deadline_ns: 3_000_000_000n,
  late_settlement_grace_ns: 2_000_000_000n,
} as const;

/** The Lambda client settings no caller may change (BR-RUA-053 "automatic retries are disabled"). */
export const PROVIDER_LAMBDA_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;

/** The options the HTTP handler factory receives (design §9.13 case 3). */
export const PROVIDER_HTTP_HANDLER_OPTIONS = {
  connectionTimeout: 0,
  requestTimeout: 0,
  socketTimeout: 0,
  throwOnRequestTimeout: false,
  keepAlive: true,
} as const;

export type ProviderHttpHandlerOptions = typeof PROVIDER_HTTP_HANDLER_OPTIONS;
