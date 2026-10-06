// Admission is read-only toward the cloud (BR-RUA-039, design §10.1): every method of every port
// it is given either reads, or is one of the four local writes `ADMISSION_LOCAL_WRITE_METHODS`
// names (synthesis into staging, the journal append, a package file create, the journal
// finalize). `PORT_METHODS` is checked against `AdmissionPorts` by the compiler: a port or a
// method added to the interface fails the typecheck until it is listed here and judged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMISSION_LOCAL_WRITE_METHODS } from '../../../src/admission/admission-ports.ts';
import type { AdmissionPorts } from '../../../src/admission/admission-ports.ts';
import type { ScopeRecomputationPorts } from '../../../src/transport-qualification/scope/scope-recomputation.ts';

type MethodsOf<P> = {
  readonly [K in keyof P as P[K] extends (...args: never[]) => unknown ? K : never]: true;
};
type FlatPorts = Omit<AdmissionPorts, 'scope' | 'paths'> & {
  readonly [K in keyof ScopeRecomputationPorts as `scope.${K}`]: ScopeRecomputationPorts[K];
};

const PORT_METHODS: { readonly [K in keyof FlatPorts]: MethodsOf<FlatPorts[K]> } = {
  git: { readGitSourceState: true },
  toolchain: { readToolchain: true },
  sts: { readCallerIdentity: true },
  lambdaAccount: { readUnreservedConcurrency: true },
  bootstrap: { readBootstrapStackStatus: true },
  coordination: { readCoordinationTable: true },
  lease: { read: true },
  packages: { readProbePackage: true },
  goldenSuite: { readGoldenSuiteRun: true },
  schemas: { readSchemaCatalog: true },
  synthesizer: { synthesize: true },
  files: { list: true, read: true, createFile: true },
  journal: { append: true, finalize: true },
  clock: { now: true },
  ids: { next: true },
  validator: { validate: true, validateAs: true },
  'scope.sources': { listFiles: true, read: true },
  'scope.bundles': { resolve: true },
  'scope.installed': { installedVersion: true },
  'scope.validator': { validate: true, validateAs: true },
};

// A query names what it returns: reads, listings, validation, the clock and id source, the
// bundle-input resolution, and the installed-version lookup.
const READ_VERB = /^(read|list|validate|now$|next$|resolve$|installedVersion$)/;

describe('admission port verbs', () => {
  it('every method reads, except the four local writes', () => {
    const methods = Object.values(PORT_METHODS).flatMap((port) => Object.keys(port));
    const writes = methods.filter((method) => !READ_VERB.test(method));
    assert.deepEqual([...new Set(writes)].toSorted(), [...ADMISSION_LOCAL_WRITE_METHODS].toSorted());
  });
});
