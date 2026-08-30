# Study 1 golden tables

These rows are the reference-value oracle for `make golden`. Each file is
one case. The harness in `study-1/test/tables-harness.test.ts` names the
Node test after `id` and asserts `input` → `expect`.

| Field | Meaning |
| --- | --- |
| `id` | Stable requirement address (`M0-A-###-slug`) |
| `requirement` | Spec checkpoint or AC id |
| `operation` | Public `protocol-records` function |
| `input` | Untrusted value passed to that function |
| `expect.ok` | Whether validation accepts |
| `expect.value` / `expect.reasons` | Accepted record or reject codes |

This repository keeps capability specs under `study-1/specs/` (no top-level
`specs/` tree). The harness therefore discovers `study-1/specs/tables/*.json`
instead of `specs/<capability>/tables/`.
