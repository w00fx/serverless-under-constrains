// The admission harness (design §10.1, §12.2): every admission port bound to a named fake, in an
// admissible state for one execution kind. The cloud reads answer the allowlisted account in
// `us-east-1` with a usable bootstrap, enough concurrency and a correctly configured, unheld
// coordination table; the golden suite is final; the work tree is clean; synthesis is the real
// `CdkAssemblySynthesizer` over a scripted CDK CLI whose output follows each synthesis context
// (`synthScript`, replaceable per test); the transport scope is recomputed by the
// production code over the WP-11 miniature project; and a run or a validation selects a usable
// probe whose snapshot that project reproduces. A test changes one fake to reach one rejection.
// Every mutating cloud call of a fake lands in `mutationLog`; local writes stay in `files` and
// `journal`.

import { CdkAssemblySynthesizer } from '../../../src/deployment-assembly/cdk-assembly-synthesizer.ts';
import { ATTEMPT_FILES } from '../../../src/admission/admission-attempt.ts';
import type {
  AdmissionOutcome,
  AdmissionPorts,
  AdmissionRequest,
  QualificationSelection,
} from '../../../src/admission/admission-ports.ts';
import { admitExecution } from '../../../src/admission/admit-execution.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { ExecutionKind, JsonValue, Uuid4, VariantId } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { PACKAGE_LOCK_PATH } from '../../../src/transport-qualification/scope/package-lock.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../src/transport-qualification/scope/scope-policy.ts';
import type { ScopeRecomputationPorts } from '../../../src/transport-qualification/scope/scope-recomputation.ts';
import { FakeLeaseStore } from '../coordination-lease/fake-lease-store.ts';
import { MEMORY_TOOLS, SteppingWallClock } from '../deployment-assembly/deployment-fixtures.ts';
import { FakeCommandRunner } from '../deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../deployment-assembly/memory-assembly-file-system.ts';
import { FinalizeRefusingJournal } from './finalize-refusing-journal.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { FixedBundleInputResolver } from '../../unit/transport-qualification/scope/support/fixed-bundle-input-resolver.ts';
import { MemoryCommittedSourceReader } from '../../unit/transport-qualification/scope/support/memory-committed-source-reader.ts';
import { MemoryInstalledPackageReader } from '../../unit/transport-qualification/scope/support/memory-installed-package-reader.ts';
import {
  SAMPLE_BUNDLES,
  SAMPLE_COMMITTED_FILES,
  SAMPLE_INSTALLED_VERSIONS,
  SAMPLE_LOCK_BYTES,
  policyBytes,
} from '../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import {
  ENVIRONMENT_INPUT_PATH,
  EVIDENCE_ROOT,
  STAGING_ROOT,
  environmentBytes,
  financialRecords,
} from './admission-fixtures.ts';
import { FakeAccountSettings } from './fake-account-settings.ts';
import { FakeBootstrapStack } from './fake-bootstrap-stack.ts';
import { FakeCallerIdentity } from './fake-caller-identity.ts';
import { FakeCoordinationTable } from './fake-coordination-table.ts';
import { FakeGitRepository } from './fake-git-repository.ts';
import { FakeGoldenSuiteRunner } from './fake-golden-suite-runner.ts';
import { FakeProbePackageReader } from './fake-probe-package-reader.ts';
import { FakeSchemaCatalog } from './fake-schema-catalog.ts';
import { FakeToolchain } from './fake-toolchain.ts';
import { ContextScriptedSynthesizer } from './context-scripted-synthesizer.ts';
import type { SynthScript } from './context-scripted-synthesizer.ts';
import { SELECTED_PROBE_ID, selectedProbePackage } from './selected-probe-package.ts';
import type { SelectedProbePackage } from './selected-probe-package.ts';
import { synthesizedAssemblyFiles } from './synth-templates.ts';

/** The id namespace of the harness's UUID source; the attempt id is its first id. */
export const HARNESS_ID_NAMESPACE = '0000a001';
export const HARNESS_STARTED_AT = '2026-10-06T09:00:00.000Z';

/**
 * The n-th id the harness's UUID source issues (1-based).
 *
 * @example
 * harnessId(1); // '0000a001-0000-4000-8000-000000000001', the admission attempt id
 */
export function harnessId(position: number): Uuid4 {
  return `${HARNESS_ID_NAMESPACE}-0000-4000-8000-${position.toString(16).padStart(12, '0')}` as Uuid4;
}

/**
 * Admission over named fakes in an admissible state.
 *
 * @example
 * const harness = await AdmissionHarness.create('RUN');
 * harness.sts = new FakeCallerIdentity({ account: FOREIGN_ACCOUNT_ID });
 * const outcome = await harness.admit();
 */
export class AdmissionHarness {
  readonly kind: ExecutionKind;
  readonly mutationLog = new RecordingMutationLog();
  readonly clock = new SteppingWallClock(HARNESS_STARTED_AT);
  readonly files = new MemoryAssemblyFileSystem();
  readonly journal = new FinalizeRefusingJournal();
  readonly ids = new SequentialUuidSource(HARNESS_ID_NAMESPACE);
  readonly validator: RecordValidator = createRecordValidator();
  readonly runner = new FakeCommandRunner(this.files);
  readonly sources = new MemoryCommittedSourceReader({
    ...SAMPLE_COMMITTED_FILES,
    [TRANSPORT_SCOPE_POLICY_PATH]: policyBytes(),
    [PACKAGE_LOCK_PATH]: SAMPLE_LOCK_BYTES,
  });
  readonly bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
  readonly installed = new MemoryInstalledPackageReader(SAMPLE_INSTALLED_VERSIONS);
  readonly lease = new FakeLeaseStore({ clock: this.clock, mutationLog: this.mutationLog });
  readonly packages = new FakeProbePackageReader(this.clock);
  git = new FakeGitRepository();
  toolchain = new FakeToolchain();
  sts = new FakeCallerIdentity();
  lambdaAccount = new FakeAccountSettings();
  bootstrap = new FakeBootstrapStack();
  coordination = new FakeCoordinationTable();
  goldenSuite = new FakeGoldenSuiteRunner();
  schemas = FakeSchemaCatalog.fromCommittedCatalog();
  /** What the scripted `cdk synth` writes for a synthesis context; tests replace it. */
  synthScript: SynthScript = (context) => synthesizedAssemblyFiles(context);
  /** The request `admit()` sends; tests replace members of it. */
  request: AdmissionRequest;
  /** The selected probe of a run or a validation; `undefined` for a probe. */
  readonly selected: SelectedProbePackage | undefined;

  private constructor(kind: ExecutionKind, selected: SelectedProbePackage | undefined, variant: VariantId) {
    this.kind = kind;
    this.selected = selected;
    this.request = {
      kind,
      environment_input_path: ENVIRONMENT_INPUT_PATH,
      financial_inputs: financialRecords(),
      ...(kind === 'VARIANT_VALIDATION' ? { variant } : {}),
      ...(selected === undefined ? {} : { qualification: selected.selection }),
    };
  }

  /**
   * An admissible harness for one kind (a validation of `variant`).
   *
   * @example
   * const harness = await AdmissionHarness.create('VARIANT_VALIDATION', 'durable');
   */
  static async create(kind: ExecutionKind, variant: VariantId = 'durable'): Promise<AdmissionHarness> {
    const scope: ScopeRecomputationPorts = {
      sources: new MemoryCommittedSourceReader({
        ...SAMPLE_COMMITTED_FILES,
        [TRANSPORT_SCOPE_POLICY_PATH]: policyBytes(),
        [PACKAGE_LOCK_PATH]: SAMPLE_LOCK_BYTES,
      }),
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: new MemoryInstalledPackageReader(SAMPLE_INSTALLED_VERSIONS),
      validator: createRecordValidator(),
    };
    const selected = kind === 'TRANSPORT_PROBE' ? undefined : await selectedProbePackage(scope);
    const harness = new AdmissionHarness(kind, selected, variant);
    if (selected !== undefined) {
      harness.packages.store(SELECTED_PROBE_ID, selected.files);
    }
    await harness.placeEnvironmentInput(environmentBytes());
    return harness;
  }

  /** Writes the operator's environment input file. */
  async placeEnvironmentInput(bytes: Uint8Array): Promise<void> {
    await this.files.removeFile(ENVIRONMENT_INPUT_PATH);
    const written = await this.files.createFile(ENVIRONMENT_INPUT_PATH, bytes, 0o600);
    if (!written.ok) {
      throw new Error(`environment input not placed: ${written.error.code}; expected a writable path`);
    }
  }

  /** The selection a run or a validation sends. */
  selection(): QualificationSelection {
    if (this.selected === undefined) {
      throw new Error(`a ${this.kind} harness selects no probe; expected a run or a validation`);
    }
    return this.selected.selection;
  }

  /** Every admission port, bound to the current fakes. */
  ports(): AdmissionPorts {
    return {
      git: this.git,
      toolchain: this.toolchain,
      sts: this.sts,
      lambdaAccount: this.lambdaAccount,
      bootstrap: this.bootstrap,
      coordination: this.coordination,
      lease: this.lease,
      packages: this.packages,
      goldenSuite: this.goldenSuite,
      schemas: this.schemas,
      synthesizer: new ContextScriptedSynthesizer({
        runner: this.runner,
        script: this.synthScript,
        synthesizer: new CdkAssemblySynthesizer({ runner: this.runner, files: this.files, tools: MEMORY_TOOLS }),
      }),
      scope: { sources: this.sources, bundles: this.bundles, installed: this.installed, validator: this.validator },
      files: this.files,
      journal: this.journal,
      clock: this.clock,
      ids: this.ids,
      validator: this.validator,
      paths: { evidence_root: EVIDENCE_ROOT, staging_root: STAGING_ROOT },
    };
  }

  /** Runs admission with the current request and fakes. */
  admit(): Promise<AdmissionOutcome> {
    return admitExecution(this.request, this.ports());
  }

  /** The attempt journal's records, in line order. */
  journalRecords(attemptId: Uuid4): readonly JsonValue[] {
    const text = this.journal.text(this.#attemptPath(attemptId, ATTEMPT_FILES.preflightJournal)) ?? '';
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => parsedJson(new TextEncoder().encode(line)));
  }

  /** Whether the attempt journal was finalized. */
  journalFinalized(attemptId: Uuid4): boolean {
    return this.journal.isFinalized(this.#attemptPath(attemptId, ATTEMPT_FILES.preflightJournal));
  }

  /** The attempt's stored rejection record, or `undefined` when none was written. */
  async rejection(attemptId: Uuid4): Promise<JsonValue | undefined> {
    const read = await this.files.read(this.#attemptPath(attemptId, ATTEMPT_FILES.admissionRejection));
    return read.ok ? parsedJson(read.value) : undefined;
  }

  /** Every path written below the evidence root outside `admission-attempts/`, relative to it. */
  async packagePaths(): Promise<readonly string[]> {
    const listed = await this.files.list(EVIDENCE_ROOT);
    if (!listed.ok) {
      return [];
    }
    return listed.value
      .filter((entry) => entry.type === 'file' && !entry.path.startsWith('admission-attempts/'))
      .map((entry) => entry.path);
  }

  /** The bytes of one file below the evidence root. */
  async evidenceFile(relativePath: string): Promise<Uint8Array> {
    const read = await this.files.read(`${EVIDENCE_ROOT}/${relativePath}`);
    if (!read.ok) {
      throw new Error(`${relativePath} unreadable: ${read.error.code}; expected a written evidence file`);
    }
    return read.value;
  }

  #attemptPath(attemptId: Uuid4, file: string): string {
    return `${EVIDENCE_ROOT}/${PACKAGE_LAYOUT.admissionAttemptDirectory(attemptId)}/${file}`;
  }
}

function parsedJson(bytes: Uint8Array): JsonValue {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    throw new Error(`evidence of ${String(bytes.length)} bytes is not JSON (${parsed.error.kind}); expected a record`);
  }
  return parsed.value;
}
