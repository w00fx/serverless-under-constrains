// OR-RUA-002 timing of the treatment barrier: code constants, never configuration. The frozen
// `provider_trial_configuration` declares the same two values; the config reader refuses a
// configuration that declares others, so the evidence can never misdescribe what ran.

/** The treatment-state polling interval and the safety release after the commit (OR-RUA-002). */
export const BARRIER_TIMING = { poll_interval_ms: 250, safety_release_ms: 15_000 } as const;
