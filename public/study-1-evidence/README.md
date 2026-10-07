# Study 1 evidence: public redacted copy

A derived view of the 6 Study 1 evidence packages and their 17 verification records.
Each original package-index.json digest is the authority for its package's files, and each verification record's original SHA-256, which results.json cites, for that record; this copy is a derived view (spec limitation 10). The raw packages stay private because they hold environment identifiers.
This copy replaces those identifiers and changes nothing else.

## Packages

| Package | Original package-index.json SHA-256 (the authority) | Redacted package-index.json SHA-256 |
|---|---|---|
| `runs/abf41ffd-3008-4b29-81ee-b65d8095188b` | `a7f866843ad6a22471993f802241417feda450e9865c3251ff8ea9c0efdeee74` | `a7f866843ad6a22471993f802241417feda450e9865c3251ff8ea9c0efdeee74` |
| `transport-probes/4f4a29c7-a8ee-4d30-ac2a-5cc5be9f2ce5` | `713185cc810fef94d7f6e43aab10ee8d7bb4571aba96a5421d3a76063f744bad` | `713185cc810fef94d7f6e43aab10ee8d7bb4571aba96a5421d3a76063f744bad` |
| `transport-probes/adfca539-508f-4a51-9a98-e1dcf8cec84a` | `1a1411b2e6956a6c42179896a6a0fff9a8dc064e93b1845e2b163181cb314f87` | `1a1411b2e6956a6c42179896a6a0fff9a8dc064e93b1845e2b163181cb314f87` |
| `variant-validations/a8a5b2f1-61d2-4712-9c54-34114abfd54e` | `9c0beedda6e643f0746e02d3282268798fe8172ce577af4a0a459639be75d62e` | `9c0beedda6e643f0746e02d3282268798fe8172ce577af4a0a459639be75d62e` |
| `variant-validations/60511328-ab4d-4234-81ab-0b042a20e658` | `b7fc14264129736e8e202fdc2c52cd590efa94bd2ab83bc7b8da9b2631e3edb8` | `b7fc14264129736e8e202fdc2c52cd590efa94bd2ab83bc7b8da9b2631e3edb8` |
| `variant-validations/eda6019a-0f5d-4565-a809-b129ec432036` | `f8a19a5a2f5394e13db089bd5be56c4d4bb78209aab5077f4df38c8d86f7934c` | `f8a19a5a2f5394e13db089bd5be56c4d4bb78209aab5077f4df38c8d86f7934c` |

## Verification records

`verifications/<execution id>/` holds the records that the operator CLI's verify commands wrote
for these packages, outside any package. `results/study-1/results.json` cites the ones it reports
by path and SHA-256. 17 of the 17 records are byte-identical to the originals.

## What was redacted

- `aws-account-id`: The AWS account id that the ARN account segments name becomes 111122223333 wherever it appears: ARNs, bucket names, queue URLs and plain values. Files changed: 88; replacements: 426.
- `checkout-path`: An absolute path through the local repository checkout becomes <checkout>/, kept from study-1/ on. Files changed: 6; replacements: 1003.
- `home-path`: Any other /Users/<name> or /home/<name> prefix becomes <home>. Files changed: 0; replacements: 0.
- `temp-path`: A macOS temporary directory, /var/folders/<a>/<b>/T with or without /private, becomes <temp-dir>. Files changed: 6; replacements: 6.

880 of the 980 files are byte-identical to the originals.

## What this copy re-derives, and what it does not

- The three monetary rules re-derive from the ledgers. `verdict-recheck.json` recomputes BR-RUA-001,
  BR-RUA-002 and BR-RUA-009 and the preservation verdict for the canonical run's 4 trials
  from their ledger snapshots, each equal to the original oracle result; 4 of those
  4 ledger snapshots are byte-identical to the originals.
- The trial-validity gates were evaluated on the private packages, not on this copy. The gates
  read the trial journals, and redaction changed 6 of the 30 journal files here, so
  each trial's validity in this copy is the original oracle result's, not re-derived.

## How to check this copy

1. `redaction-manifest.json` lists every file with `original_sha256`, the digest its package
   index records, and `redacted_sha256`, the digest of the bytes here. A file no rule changed
   has the same digest in both, so it checks directly against its package index.
2. `results/study-1/results.json` cites each package by `package_index_sha256`: the original
   digest in the table above. It cites each verification record by `path` and `sha256`: the
   `original_sha256` the manifest lists for that path.
3. `verdict-recheck.json` holds the recomputed rules beside the oracle result, and the ledger
   digests on both sides.
4. The owner of the raw packages re-verifies each one from its own bytes with
   `npm run rua -- run verify <package>` (or `validation verify`, `probe verify`), and re-derives
   this copy byte for byte with `npm run redact -- --check` in `study-1/`.
