# Keep variant validations outside canonical runs

Conventional and Durable implementation validation each use an immutable two-trial package with its own `variant_validation_id`, explicit envelope, and no fabricated `run_id`; only the four-cell lifecycle creates a canonical study run or BR-7 comparison. This preserves executable milestone evidence without normalizing missing cells, extending earlier packages, or allowing development validation to be cited as an architectural comparison.
