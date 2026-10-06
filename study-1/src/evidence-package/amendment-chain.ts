// The amendment graph of one package (design §8.16 step 6; BR-RUA-043): chains must be linear,
// digest-valid, cycle-free and explicitly selected.
// - Every amendment belongs to the execution and names the original package index; sequence 1 has
//   no parent and sequence n names the index digest of an amendment of sequence n-1
//   (`BROKEN_PARENT`).
// - Sequences are dense from 1 (`SEQUENCE_GAP`), and following parents never returns to an
//   amendment already visited (`CYCLE`).
// - The selected head is a known amendment (`UNKNOWN_HEAD`); the selected chain is the head and its
//   ancestors, and every known amendment outside it is an `UNSELECTED_DESCENDANT`.
// Amendments are identified by the digest of their `amendment-index.json` bytes. The walk is
// bounded by a visited set, so a cycle (only constructible with an aliasing digest) terminates.

import type { ExecutionIdentity, Sha256Hex } from '../record-contract/primitives.ts';
import type { AmendmentIndex } from '../record-contract/records/group-c/amendment_index.ts';
import type {
  AmendmentLink,
  PackageIneligibilityReason,
} from '../record-contract/records/group-c/package_verification.ts';
import { belongsToExecution } from './execution-correlation.ts';
import { ineligibility } from './package-integrity.ts';
import type { PackageFile } from './package-file-system.ts';

/** One amendment whose index parsed, identified by the digest of its index bytes. */
export interface ParsedAmendment {
  /** Where it was found, for reason details, for example `amendments/<id>/0001-<a>/`. */
  readonly location: string;
  readonly index: AmendmentIndex;
  readonly index_sha256: Sha256Hex;
  /** Every stored file, at paths relative to the amendment directory. */
  readonly files: readonly PackageFile[];
}

export interface AmendmentGraphInput {
  readonly identity: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly original_package_index_sha256: Sha256Hex;
  readonly amendments: readonly ParsedAmendment[];
  readonly selected_head: Sha256Hex | null;
}

export interface AmendmentGraph {
  /** The selected head and its ancestors, ascending by sequence; partial when the chain is broken. */
  readonly selected_chain: readonly ParsedAmendment[];
  /** Every amendment found, ascending by sequence then digest. */
  readonly known_descendants: readonly AmendmentLink[];
  readonly reasons: readonly PackageIneligibilityReason[];
}

/**
 * Resolves the selected chain and every reason the amendment graph is not a complete, linear,
 * digest-valid, cycle-free chain with nothing left unselected.
 *
 * @example
 * const graph = resolveAmendmentGraph({ identity, execution_manifest_sha256, original_package_index_sha256, amendments, selected_head });
 * graph.reasons.length === 0; // a complete selected chain
 */
export function resolveAmendmentGraph(input: AmendmentGraphInput): AmendmentGraph {
  const byDigest = new Map<Sha256Hex, ParsedAmendment>();
  for (const amendment of input.amendments) {
    byDigest.set(amendment.index_sha256, byDigest.get(amendment.index_sha256) ?? amendment);
  }
  const chain = selectedChain(input.selected_head, byDigest);
  const inChain = new Set(chain.map((amendment) => amendment.index_sha256));
  const reasons = [
    ...input.amendments.flatMap((amendment) => membershipReasons(amendment, input)),
    ...input.amendments.flatMap((amendment) => parentReasons(amendment, byDigest)),
    ...duplicateDigestReasons(input.amendments),
    ...sequenceGapReasons(input.amendments),
    ...cycleReasons(input.amendments, byDigest),
    ...headReasons(input.selected_head, byDigest),
    ...input.amendments.filter((amendment) => !inChain.has(amendment.index_sha256)).map(unselected),
  ];
  return {
    selected_chain: chain,
    known_descendants: input.amendments.map(amendmentLink).toSorted(compareLinks),
    reasons,
  };
}

/**
 * The verification record's view of one amendment.
 *
 * @example
 * amendmentLink(parsed); // { sequence: 1, amendment_id, amendment_kind: 'BILLING', amendment_index_sha256 }
 */
export function amendmentLink(amendment: ParsedAmendment): AmendmentLink {
  return {
    sequence: amendment.index.sequence,
    amendment_id: amendment.index.amendment_id,
    amendment_kind: amendment.index.amendment_kind,
    amendment_index_sha256: amendment.index_sha256,
  };
}

function selectedChain(
  head: Sha256Hex | null,
  byDigest: ReadonlyMap<Sha256Hex, ParsedAmendment>,
): readonly ParsedAmendment[] {
  const walked: ParsedAmendment[] = [];
  const visited = new Set<Sha256Hex>();
  for (
    let next = head === null ? undefined : byDigest.get(head);
    next !== undefined && !visited.has(next.index_sha256);
  ) {
    visited.add(next.index_sha256);
    walked.push(next);
    const parent = next.index.parent_amendment_index_sha256;
    next = parent === null ? undefined : byDigest.get(parent);
  }
  return walked.toReversed();
}

function membershipReasons(
  amendment: ParsedAmendment,
  input: AmendmentGraphInput,
): readonly PackageIneligibilityReason[] {
  const { index } = amendment;
  const problems = [
    belongsToExecution(index, input.identity) ? [] : ['it names another execution'],
    index.execution_manifest_sha256 === input.execution_manifest_sha256
      ? []
      : [`its execution_manifest_sha256 is ${index.execution_manifest_sha256}, not ${input.execution_manifest_sha256}`],
    index.original_package_index_sha256 === input.original_package_index_sha256
      ? []
      : [
          `its original_package_index_sha256 is ${index.original_package_index_sha256}, not ${input.original_package_index_sha256}`,
        ],
  ].flat();
  return problems.map((problem) =>
    broken(amendment, `${problem}; expected an amendment of this execution's original package`),
  );
}

function parentReasons(
  amendment: ParsedAmendment,
  byDigest: ReadonlyMap<Sha256Hex, ParsedAmendment>,
): readonly PackageIneligibilityReason[] {
  const { sequence, parent_amendment_index_sha256: parent } = amendment.index;
  if (sequence === 1) {
    return parent === null ? [] : [broken(amendment, `sequence 1 names parent ${parent}; expected null`)];
  }
  const parentSequence = parent === null ? undefined : byDigest.get(parent)?.index.sequence;
  if (parentSequence === sequence - 1) {
    return [];
  }
  const found =
    parentSequence === undefined ? 'no known amendment' : `an amendment of sequence ${String(parentSequence)}`;
  return [
    broken(
      amendment,
      `sequence ${String(sequence)} names parent ${String(parent)}, ${found}; expected the index digest of the amendment of sequence ${String(sequence - 1)}`,
    ),
  ];
}

function duplicateDigestReasons(amendments: readonly ParsedAmendment[]): readonly PackageIneligibilityReason[] {
  const seen = new Set<Sha256Hex>();
  return amendments.flatMap((amendment) => {
    const repeated = seen.has(amendment.index_sha256);
    seen.add(amendment.index_sha256);
    return repeated
      ? [
          broken(
            amendment,
            `its index digest ${amendment.index_sha256} is shared with another amendment; expected one amendment per digest`,
          ),
        ]
      : [];
  });
}

function sequenceGapReasons(amendments: readonly ParsedAmendment[]): readonly PackageIneligibilityReason[] {
  const sequences = [...new Set(amendments.map((amendment) => amendment.index.sequence))].toSorted((a, b) => a - b);
  return sequences.flatMap((sequence, position) => {
    const expected = (sequences[position - 1] ?? 0) + 1;
    if (sequence === expected) {
      return [];
    }
    const missing = sequence - 1 === expected ? String(expected) : `${String(expected)}..${String(sequence - 1)}`;
    return [
      ineligibility(
        'SEQUENCE_GAP',
        `amendment sequence ${missing} is missing before ${String(sequence)}; expected dense sequences from 1`,
        'amendments',
      ),
    ];
  });
}

function cycleReasons(
  amendments: readonly ParsedAmendment[],
  byDigest: ReadonlyMap<Sha256Hex, ParsedAmendment>,
): readonly PackageIneligibilityReason[] {
  const settled = new Set<Sha256Hex>();
  return amendments.flatMap((start) => {
    const path = new Set<Sha256Hex>();
    let next: ParsedAmendment | undefined = start;
    while (next !== undefined && !settled.has(next.index_sha256) && !path.has(next.index_sha256)) {
      path.add(next.index_sha256);
      const parent: Sha256Hex | null = next.index.parent_amendment_index_sha256;
      next = parent === null ? undefined : byDigest.get(parent);
    }
    const reentered = next !== undefined && path.has(next.index_sha256) ? next : undefined;
    for (const digest of path) {
      settled.add(digest);
    }
    return reentered === undefined
      ? []
      : [
          ineligibility(
            'CYCLE',
            `following parents from ${reentered.location} returns to index digest ${reentered.index_sha256}; expected a chain that ends at sequence 1`,
            reentered.location,
          ),
        ];
  });
}

function headReasons(
  head: Sha256Hex | null,
  byDigest: ReadonlyMap<Sha256Hex, ParsedAmendment>,
): readonly PackageIneligibilityReason[] {
  if (head === null || byDigest.has(head)) {
    return [];
  }
  return [
    ineligibility(
      'UNKNOWN_HEAD',
      `selected head ${head} is the index digest of no known amendment; expected a known amendment`,
      'amendments',
    ),
  ];
}

function unselected(amendment: ParsedAmendment): PackageIneligibilityReason {
  return ineligibility(
    'UNSELECTED_DESCENDANT',
    `${amendment.location} (sequence ${String(amendment.index.sequence)}, index digest ${amendment.index_sha256}) is outside the selected chain; expected every known amendment to be selected`,
    amendment.location,
  );
}

function broken(amendment: ParsedAmendment, detail: string): PackageIneligibilityReason {
  return ineligibility('BROKEN_PARENT', `${amendment.location}: ${detail}`, amendment.location);
}

function compareLinks(a: AmendmentLink, b: AmendmentLink): number {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  return a.amendment_index_sha256 < b.amendment_index_sha256 ? -1 : 1;
}
