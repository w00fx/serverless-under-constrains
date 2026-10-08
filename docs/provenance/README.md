# CAP-RUA provenance

Copies of the run records that the Study 1 ratification cites. The originals live in
`.agent-runs/rua-2026-10-05/`, which is gitignored. Nothing else from that folder is
published. Copied on 2026-10-07.

| File | Source | What was copied |
|---|---|---|
| `addendum-approved.md` | `design/addendum-approved.md` | The whole file, with one redaction (below) |
| `decisions-excerpt.md` | `decisions.md` | The header, rows 1–4 (the human approvals that cite the addendum), row 100 (delivery, including `fd26225`) and row 101 (the `fd26225` deviation) |

## Redaction

Addendum line 77 named the repository by its absolute path on the owner's machine. The
copy reads `<repository root>` instead. Nothing else differs:
`diff design/addendum-approved.md docs/provenance/addendum-approved.md` reports only line 77.

SHA-256 of the original addendum:
`b3cfcaf196613b5b7dfbd9088a59099c1e82546fb1d5173fa0c80453896a31dd`.

## Checked before publishing

Both copies were searched for the sandbox account ID, absolute home and temp paths, email
addresses other than the public commit identity, AWS profile names and access-key
prefixes. The only match was line 77.
