# The truth layer

`specs/**` (including `tables/`), the golden tests, and
`.metrics-baseline.json` are the truth layer — the material every
verification reads. Casual sessions **read it, never write it.**

Changing truth has named flows, and only those flows write:

- Spec content → the `to-spec` skill, or the supervised adapter's **gated** semantic amendment (writer matrix) (create or delta), committed alone at the gate.
- QA contracts (`specs/qa/**`) → the `to-spec` skill, ratified by the merge of
  their PR like any spec content.
- Acceptance criteria → explicit human approval in-session; typed
  stable IDs are never renumbered or reused, only retired (tickets
  point at the IDs).
- Reference values → the human's signature: a value changes because a
  cited source changed, and the human confirms it.
- The ratchet baseline → only via its own shrink-and-lock step.

If a task seems to require editing truth outside these flows, that is
the finding — stop and name the flow; don't make the edit. A silently
edited reference table corrupts the oracle: everything downstream goes
green *and lying*.

Two floor behaviors, every session — with or without a skill:

- Work happens on a typed branch (`feature/`, `fix/`, `chore/`, …),
  never the default branch.
- "Done" is demonstrated with the runner's output visible — a claim
  without output is a claim.

Loading contract: Codex, Cursor and other `AGENTS.md` readers reach this file
through the root `AGENTS.md`; Claude Code loads the byte-identical copy that
`install-codex-port.sh --target claude` generates. Transactional skills read it
explicitly in every harness. Keep one canonical rule here and never hand-edit a
generated copy; the gate fails on drift.
