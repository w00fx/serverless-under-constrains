// Provisioning from the frozen assembly (design §9.8 D1-D4; BR-RUA-040, BR-RUA-042, BR-RUA-050,
// BR-RUA-053; D-25; addendum §2.4). One call deploys one execution's stack and freezes its
// resource manifest:
// 0. the frozen inputs are read from the package: the assembly inventory (its digest must be the
//    one the execution manifest froze), the declared stack tags and the template (its digest must
//    be the frozen `template_sha256`), from which the post-deploy reads are planned;
// D1. the frozen assembly is copied into `<deploy_staging_root>/<execution_id>/` and the copy is
//    proven byte-identical to the inventory (`DEPLOY_COPY_VERIFIED`); a copy that does not verify is
//    never deployed;
// D2. `cdk deploy` of that copy (`DEPLOY_STARTED`, then `DEPLOY_SUCCEEDED` or `DEPLOY_FAILED`);
// D3. the package copy is re-inventoried and must still equal the inventory
//    (`PACKAGE_ASSEMBLY_REVERIFIED`); drift is a reason, never silently accepted;
// D4. the stack is described and its resources listed even after a failed deployment, so a
//    `partial` manifest records what CloudFormation created; the configuration is read only from a
//    deployed stack; `STACK_ID_RECORDED` names the ownership boundary.
// The manifest is always frozen with `writeOnce`, `failed` and `partial` ones included. It is
// `succeeded` only when no reason at all was found: a reason the manifest builder does not see
// (assembly drift, existing provisioned concurrency, a failed read, an unwritten journal event)
// demotes it to `partial`, so the frozen status never claims more than provisioning proved. The
// only call that freezes nothing is one whose declared tags cannot be read or are not a valid
// BR-RUA-050 set of the execution: nothing deploys then, the refusal is journalled, and no valid
// manifest exists (admission A12 proved the tags, so it takes a corrupted package or a caller that
// names another execution).

import { join } from 'node:path';

import { boundedJsonText } from '../record-contract/json-value.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import type { FrozenDeploymentAssembly } from '../record-contract/records/group-a/execution_manifest.ts';
import type { KeyValueEntry, ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import { EXECUTION_PATHS, executionIdOf } from '../evidence-package/package-layout.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { parsePackageRecord } from '../evidence-package/package-records.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import { readAssemblyListing } from './assembly-listing.ts';
import type { AssemblyDeployer, DeployReport } from './assembly-ports.ts';
import { verifyAssemblyUnchanged } from './assembly-verification.ts';
import {
  configurationSnapshotOf,
  declaredStackTags,
  planPostDeployReads,
  resolveReadRequests,
} from './configuration-reading-plan.ts';
import type {
  ConfigurationSnapshot,
  PostDeployReadPlan,
  ReadOutcome,
  ReadRequest,
} from './configuration-reading-plan.ts';
import { prepareVerifiedDeployCopy } from './deploy-copy.ts';
import { deploymentReason } from './deployment-reasons.ts';
import { checkDeclaredTags } from './ownership-tag-checks.ts';
import { listAllStackResources, stackReadReason } from './post-deploy-reading.ts';
import type { AttributeReading, PostDeployRead, PostDeployReader } from './post-deploy-reading.ts';
import { ProvisioningJournal } from './provisioning-journal.ts';
import type { StackResourceSummary } from './provisioning-readings.ts';
import { buildResourceManifest, expectedStackName } from './resource-manifest.ts';
import type { StackDescription } from './resource-manifest.ts';

/** The file `cdk deploy` writes the stack outputs to, inside the temporary copy. */
export const DEPLOY_OUTPUTS_FILE = 'outputs.json';
const ASSEMBLY_MANIFEST = 'manifest.json';
const decoder = new TextDecoder();

export interface FrozenAssemblyProvisionerDeps {
  /** Absolute paths: the frozen package copy and the temporary deploy copies. */
  readonly assembly_files: AssemblyFileSystem;
  /** Paths relative to `evidence_root`. */
  readonly package_files: PackageFileSystem;
  /** The append-only file the provisioning journal is written to, relative to `evidence_root`. */
  readonly journal_file: AppendOnlyFile;
  readonly deployer: AssemblyDeployer;
  readonly reader: PostDeployReader;
  readonly validator: RecordValidator;
  readonly clock: WallClock;
  readonly ids: UuidSource;
  /** The absolute evidence root the package directory is below. */
  readonly evidence_root: string;
  /** The absolute directory holding one temporary deploy copy per execution (`.deploy-staging`). */
  readonly deploy_staging_root: string;
}

/** The admitted execution to provision. */
export interface ProvisioningSubject {
  readonly identity: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  /** `execution_manifest.deployment_assembly`. */
  readonly deployment_assembly: FrozenDeploymentAssembly;
  /** The package directory below the evidence root, for example `runs/<run_id>`. */
  readonly package_directory: string;
}

/** The frozen manifest, its stored digest, the stack outputs and every reason it is not `succeeded`. */
export interface FrozenProvisioning {
  readonly resource_manifest: ResourceManifest;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly outputs: readonly KeyValueEntry[];
  /** Empty exactly when provisioning succeeded and trials may start. */
  readonly reasons: readonly StructuredReason[];
}

interface FrozenInputs {
  readonly inventory: DeploymentAssemblyInventory;
  readonly plan: PostDeployReadPlan;
}

interface CloudFacts {
  readonly stack: StackDescription | undefined;
  readonly resources: readonly StackResourceSummary[] | undefined;
  readonly snapshot: ConfigurationSnapshot;
}

interface Freeze {
  readonly subject: ProvisioningSubject;
  readonly journal: ProvisioningJournal;
  readonly declared_tags: readonly KeyValueEntry[];
  readonly provider_version_logical_id: string;
  readonly deploy: DeployReport;
  readonly cloud: CloudFacts;
  readonly reasons: readonly StructuredReason[];
}

const NO_CLOUD: CloudFacts = { stack: undefined, resources: [], snapshot: { readings: [], reasons: [] } };

/**
 * Deploys the frozen assembly of one execution and freezes its resource manifest.
 *
 * @example
 * const provisioner = new FrozenAssemblyProvisioner({ assembly_files, package_files, journal_file, deployer, reader,
 *   validator, clock, ids, evidence_root: '/work/evidence', deploy_staging_root: '/study-1/.deploy-staging' });
 * const provisioned = await provisioner.provision({ identity, execution_manifest_sha256, deployment_assembly, package_directory: 'runs/<id>' });
 * if (provisioned.ok && provisioned.value.reasons.length === 0) startTrials(provisioned.value.outputs);
 */
export class FrozenAssemblyProvisioner {
  readonly #deps: FrozenAssemblyProvisionerDeps;

  constructor(deps: FrozenAssemblyProvisionerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs D1-D4 for `subject`; the error side holds the reasons when no manifest could be built.
   *
   * @example
   * const provisioned = await provisioner.provision(subject);
   * if (provisioned.ok) provisioned.value.resource_manifest.provisioning_status; // 'succeeded' | 'partial' | 'failed'
   */
  async provision(subject: ProvisioningSubject): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>> {
    const journal = this.#journalOf(subject);
    const frozenDir = join(
      this.#deps.evidence_root,
      subject.package_directory,
      subject.deployment_assembly.assembly_path,
    );
    const stackName = expectedStackName(subject.identity);
    const tags = await this.#declaredTags(frozenDir, stackName, subject.identity);
    if (!tags.ok) {
      return this.#notDeployed(subject, journal, [], stackName, tags.error);
    }
    const inputs = await this.#frozenInputs(subject, frozenDir);
    if (!inputs.ok) {
      return this.#notDeployed(subject, journal, tags.value, stackName, inputs.error);
    }
    const copyDir = join(this.#deps.deploy_staging_root, executionIdOf(subject.identity));
    const copy = await prepareVerifiedDeployCopy(frozenDir, inputs.value.inventory, copyDir, this.#deps.assembly_files);
    if (!copy.ok) {
      return this.#notDeployed(subject, journal, tags.value, stackName, copy.error);
    }
    const journalled = [
      await journal.copyVerified(copy.value.inventory_sha256),
      await journal.deployStarted(stackName),
    ];
    const deploy = await this.#deps.deployer.deploy(copy.value, stackName, join(copy.value.dir, DEPLOY_OUTPUTS_FILE));
    journalled.push(await (deploy.deployed ? journal.deploySucceeded() : journal.deployFailed(failureReasons(deploy))));
    const drift = await this.#reverify(inputs.value.inventory, frozenDir);
    journalled.push(
      drift.length === 0 ? await journal.assemblyReverified(inputs.value.inventory.inventory_sha256) : undefined,
    );
    const cloud = await this.#readCloud(stackName, inputs.value.plan, deploy.deployed);
    return this.#freeze({
      subject,
      journal,
      declared_tags: tags.value,
      provider_version_logical_id: inputs.value.plan.provider_version_logical_id,
      deploy,
      cloud,
      reasons: [...journalled.filter((reason) => reason !== undefined), ...drift],
    });
  }

  #journalOf(subject: ProvisioningSubject): ProvisioningJournal {
    return new ProvisioningJournal({
      file: this.#deps.journal_file,
      package_directory: subject.package_directory,
      identity: subject.identity,
      execution_manifest_sha256: subject.execution_manifest_sha256,
      clock: this.#deps.clock,
      ids: this.#deps.ids,
    });
  }

  // The declared tags must be a valid BR-RUA-050 set of this execution before anything deploys:
  // a stack whose ownership cannot be proven is never created.
  async #declaredTags(
    frozenDir: string,
    stackName: string,
    identity: ExecutionIdentity,
  ): Promise<Result<KeyValueEntry[], readonly StructuredReason[]>> {
    const bytes = await this.#deps.assembly_files.read(join(frozenDir, ASSEMBLY_MANIFEST));
    if (!bytes.ok) {
      return err([
        deploymentReason(
          'DECLARED_TAGS_UNREADABLE',
          'BR-RUA-050',
          `${bytes.error.code}: ${bytes.error.detail}; expected the frozen ${ASSEMBLY_MANIFEST} declaring the stack tags`,
        ),
      ]);
    }
    const declared = declaredStackTags(bytes.value, stackName);
    if (!declared.ok) {
      return err([declared.error]);
    }
    const checked = checkDeclaredTags(identity, declared.value);
    return checked.ok ? declared : checked;
  }

  async #frozenInputs(
    subject: ProvisioningSubject,
    frozenDir: string,
  ): Promise<Result<FrozenInputs, readonly StructuredReason[]>> {
    const inventory = await this.#inventory(subject);
    if (!inventory.ok) {
      return err([inventory.error]);
    }
    const template = await this.#template(subject.deployment_assembly, frozenDir);
    const plan = template.ok ? planPostDeployReads(template.value) : template;
    if (!plan.ok) {
      return err([plan.error]);
    }
    return ok({ inventory: inventory.value, plan: plan.value });
  }

  async #inventory(subject: ProvisioningSubject): Promise<Result<DeploymentAssemblyInventory, StructuredReason>> {
    const path = `${subject.package_directory}/${EXECUTION_PATHS.deploymentAssemblyInventory}`;
    const bytes = await this.#deps.package_files.read(path);
    if (!bytes.ok) {
      return err(
        frozenReason('FROZEN_INVENTORY_UNREADABLE', `${bytes.error.code}: ${bytes.error.detail}; expected ${path}`),
      );
    }
    const inventory = parsePackageRecord(bytes.value, 'deployment_assembly_inventory', this.#deps.validator, path);
    const frozen = subject.deployment_assembly.inventory_sha256;
    if (!inventory.ok || inventory.value.inventory_sha256 === frozen) {
      return inventory;
    }
    return err(
      frozenReason(
        'FROZEN_INVENTORY_MISMATCH',
        `${path} has inventory_sha256 ${inventory.value.inventory_sha256}; expected ${frozen} from the execution manifest`,
      ),
    );
  }

  async #template(
    assembly: FrozenDeploymentAssembly,
    frozenDir: string,
  ): Promise<Result<Uint8Array, StructuredReason>> {
    const prefix = `${assembly.assembly_path}/`;
    if (!assembly.template_path.startsWith(prefix)) {
      return err(
        frozenReason(
          'FROZEN_TEMPLATE_OUTSIDE_ASSEMBLY',
          `template_path ${boundedJsonText(assembly.template_path)}; expected a file below ${boundedJsonText(prefix)}`,
        ),
      );
    }
    const bytes = await this.#deps.assembly_files.read(join(frozenDir, assembly.template_path.slice(prefix.length)));
    if (!bytes.ok) {
      return err(
        frozenReason(
          'FROZEN_TEMPLATE_UNREADABLE',
          `${bytes.error.code}: ${bytes.error.detail}; expected ${assembly.template_path}`,
        ),
      );
    }
    const digest = sha256Hex(bytes.value);
    if (digest === assembly.template_sha256) {
      return bytes;
    }
    return err(
      frozenReason(
        'FROZEN_TEMPLATE_MISMATCH',
        `${assembly.template_path} hashes to ${digest}; expected template_sha256 ${assembly.template_sha256}`,
      ),
    );
  }

  // Nothing was deployed: the reasons are journalled as DEPLOY_FAILED and a `failed` manifest is
  // frozen with a deployment that started and ended at once without deploying.
  async #notDeployed(
    subject: ProvisioningSubject,
    journal: ProvisioningJournal,
    declaredTags: readonly KeyValueEntry[],
    stackName: string,
    reasons: readonly StructuredReason[],
  ): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>> {
    const now = formatUtcMillis(this.#deps.clock.now());
    const deploy = { stack_name: stackName, deployed: false, started_at: now, completed_at: now, outputs: [], reasons };
    const journalled = await journal.deployFailed(failureReasons(deploy));
    return this.#freeze({
      subject,
      journal,
      declared_tags: declaredTags,
      provider_version_logical_id: '',
      deploy,
      cloud: NO_CLOUD,
      reasons: journalled === undefined ? [] : [journalled],
    });
  }

  async #reverify(inventory: DeploymentAssemblyInventory, frozenDir: string): Promise<readonly StructuredReason[]> {
    const listing = await readAssemblyListing(this.#deps.assembly_files, frozenDir);
    return listing.ok ? verifyAssemblyUnchanged(inventory, listing.value) : listing.error;
  }

  async #readCloud(stackName: string, plan: PostDeployReadPlan, deployed: boolean): Promise<CloudFacts> {
    const described = await this.#deps.reader.describeStack(stackName);
    const stack = described.ok ? described.value : undefined;
    const describeReasons = described.ok ? [] : [stackReadReason('DescribeStacks', stackName, described.error)];
    const listed =
      described.ok && stack === undefined
        ? ok([])
        : await listAllStackResources(this.#deps.reader, stack?.stack_id ?? stackName);
    const resources = listed.ok ? listed.value : undefined;
    const snapshot = deployed && resources !== undefined ? await this.#readConfiguration(plan, resources) : undefined;
    return {
      stack,
      resources,
      snapshot: {
        readings: snapshot?.readings ?? [],
        reasons: [...describeReasons, ...(listed.ok ? [] : [listed.error]), ...(snapshot?.reasons ?? [])],
      },
    };
  }

  async #readConfiguration(
    plan: PostDeployReadPlan,
    resources: readonly StackResourceSummary[],
  ): Promise<ConfigurationSnapshot> {
    const resolved = resolveReadRequests(plan.reads, resources);
    const outcomes: ReadOutcome[] = [];
    for (const request of resolved.requests) {
      outcomes.push({ request, answer: await readOne(this.#deps.reader, request) });
    }
    const snapshot = configurationSnapshotOf(outcomes);
    return { readings: snapshot.readings, reasons: [...resolved.reasons, ...snapshot.reasons] };
  }

  async #freeze(input: Freeze): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>> {
    const built = buildResourceManifest({
      identity: input.subject.identity,
      execution_manifest_sha256: input.subject.execution_manifest_sha256,
      declared_tags: input.declared_tags,
      provider_version_logical_id: input.provider_version_logical_id,
      deploy: input.deploy,
      stack: input.cloud.stack,
      resources: input.cloud.resources,
      configuration: input.cloud.snapshot.readings,
      frozen_at: formatUtcMillis(this.#deps.clock.now()),
    });
    if (!built.ok) {
      // Only refused declared tags reach here, frozen with the empty placeholder set: no valid
      // manifest exists, and the deployment reasons already say why the tags were refused.
      return err([...input.deploy.reasons, ...input.reasons]);
    }
    const stackId = built.value.manifest.stack_id;
    const recorded = stackId === undefined ? undefined : await input.journal.stackIdRecorded(stackId);
    const reasons = [
      ...built.value.reasons,
      ...input.reasons,
      ...input.cloud.snapshot.reasons,
      ...(recorded === undefined ? [] : [recorded]),
    ];
    const manifest = demoted(built.value.manifest, reasons.length > 0);
    return this.#write(input.subject, manifest, reasons);
  }

  async #write(
    subject: ProvisioningSubject,
    manifest: ResourceManifest,
    reasons: readonly StructuredReason[],
  ): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>> {
    const path = `${subject.package_directory}/${EXECUTION_PATHS.resourceManifest}`;
    const bytes = serializeRecordFile(manifest);
    // The bytes written are the bytes validated; canonical serialization always parses back.
    const checked = this.#deps.validator.validateAs(
      'resource_manifest',
      JSON.parse(decoder.decode(bytes)) as JsonValue,
    );
    if (!checked.valid) {
      const violations = checked.violations;
      return err([
        ...reasons,
        frozenReason(
          'RESOURCE_MANIFEST_INVALID',
          `${path} violates its schema: ${boundedJsonText(violations.map((violation) => `${violation.instance_path} ${violation.detail}`))}; expected a valid resource_manifest`,
        ),
      ]);
    }
    const written = await this.#deps.package_files.writeOnce(path, bytes);
    const writeReasons = written.ok
      ? []
      : [
          frozenReason(
            'RESOURCE_MANIFEST_NOT_WRITTEN',
            `${written.error.code}: ${written.error.detail}; expected ${path} written once`,
          ),
        ];
    return ok({
      resource_manifest: manifest,
      resource_manifest_sha256: sha256Hex(bytes),
      outputs: manifest.outputs,
      reasons: [...reasons, ...writeReasons],
    });
  }
}

function readOne(reader: PostDeployReader, request: ReadRequest): PostDeployRead<readonly AttributeReading[]> {
  switch (request.kind) {
    case 'function_configuration':
      return reader.readFunctionConfiguration(request.function_name, request.qualifier);
    case 'provisioned_concurrency':
      return reader.readProvisionedConcurrency(request.function_name, request.qualifier);
    case 'event_source_mapping':
      return reader.readEventSourceMapping(request.uuid);
    case 'queue':
      return reader.readQueueAttributes(request.queue_url);
    case 'table':
      return reader.readTable(request.table_name);
  }
}

// The manifest stays `succeeded` only when nothing at all was found wanting (addendum §2.4,
// BR-RUA-040): a succeeded manifest lists resources, so the demoted status is `partial`.
function demoted(manifest: ResourceManifest, wanting: boolean): ResourceManifest {
  if (!wanting || manifest.provisioning_status !== 'succeeded') {
    return manifest;
  }
  return { ...manifest, provisioning_status: 'partial' };
}

// DEPLOY_FAILED carries at least one reason (its schema's minItems): the summary, then the details.
function failureReasons(deploy: DeployReport): readonly [StructuredReason, ...StructuredReason[]] {
  return [
    deploymentReason(
      'STACK_NOT_DEPLOYED',
      'BR-RUA-040',
      `${deploy.stack_name} was not deployed (${String(deploy.reasons.length)} reasons follow); expected a deployed stack`,
    ),
    ...deploy.reasons,
  ];
}

function frozenReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-042', detail);
}
