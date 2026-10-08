// The provisioning journal (design §7 `provisioning/provisioning-journal.jsonl`, §6.2 row 46, §9.8
// D1-D4; BR-RUA-040, BR-RUA-042, D-25): one `provisioning_event_recorded` line per step of the
// deployment from the verified temporary copy. It is the runner's own source instance in the
// execution partition, written through the event journal's `JournalWriter` (BR-RUA-033: dense
// sequence, identical retry of a definitive failure, an ambiguous append stops the instance).
// Each event names the step before it as its immediate cause, because each step runs only once the
// step before it ended. An event that is not written is a reason, never a throw: the missing proof
// keeps provisioning from succeeding, and the deployment itself still finishes and is recorded in
// the resource manifest.

import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type {
  ExecutionIdentity,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** Identical retries of a definitively failed provisioning append (BR-RUA-033), as the runner's. */
export const PROVISIONING_DEFINITIVE_RETRIES = 2;

/** What the provisioning journal of one execution needs. */
export interface ProvisioningJournalInput {
  readonly file: AppendOnlyFile;
  /** The package directory below the evidence root, for example `runs/<run_id>`. */
  readonly package_directory: string;
  readonly identity: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly clock: WallClock;
  readonly ids: UuidSource;
}

type ProvisioningEventBody = EventBody<'provisioning_event_recorded'>;

/**
 * The provisioning events of one execution, appended in order.
 *
 * @example
 * const journal = new ProvisioningJournal({ file, package_directory: 'runs/<id>', identity, execution_manifest_sha256, clock, ids });
 * const problem = await journal.copyVerified(inventory.inventory_sha256); // undefined when written
 */
export class ProvisioningJournal {
  readonly #writer: JournalWriter;
  #previous: Uuid4 | undefined;

  constructor(input: ProvisioningJournalInput) {
    this.#writer = new JournalWriter({
      port: createJsonlJournalPort(`${input.package_directory}/${EXECUTION_PATHS.provisioningJournal}`, input.file),
      source: 'runner',
      instanceId: input.ids.next(),
      scope: {
        execution: input.identity,
        execution_manifest_sha256: input.execution_manifest_sha256,
        partition: { kind: 'execution' },
      },
      clock: input.clock,
      ids: input.ids,
      maxDefinitiveRetries: PROVISIONING_DEFINITIVE_RETRIES,
    });
  }

  /**
   * D1: the temporary copy equals the frozen inventory.
   *
   * @example
   * await journal.copyVerified(copy.inventory_sha256);
   */
  copyVerified(inventorySha256: Sha256Hex): Promise<StructuredReason | undefined> {
    return this.#record({ provisioning_event: 'DEPLOY_COPY_VERIFIED', inventory_sha256: inventorySha256, reasons: [] });
  }

  /**
   * D2: `cdk deploy` of the verified copy starts.
   *
   * @example
   * await journal.deployStarted('SucRua-run-3f1c2a9e');
   */
  deployStarted(stackName: string): Promise<StructuredReason | undefined> {
    return this.#record({ provisioning_event: 'DEPLOY_STARTED', stack_name: stackName, reasons: [] });
  }

  /**
   * D2: the deployment succeeded.
   *
   * @example
   * await journal.deploySucceeded();
   */
  deploySucceeded(): Promise<StructuredReason | undefined> {
    return this.#record({ provisioning_event: 'DEPLOY_SUCCEEDED', reasons: [] });
  }

  /**
   * D1 or D2: nothing was deployed from a verified copy, or the deployment failed; `reasons`
   * says why and holds at least one reason.
   *
   * @example
   * await journal.deployFailed(report.reasons);
   */
  deployFailed(reasons: readonly [StructuredReason, ...StructuredReason[]]): Promise<StructuredReason | undefined> {
    return this.#record({ provisioning_event: 'DEPLOY_FAILED', reasons: [...reasons] });
  }

  /**
   * D3: the package copy still equals the frozen inventory after the deployment.
   *
   * @example
   * await journal.assemblyReverified(inventory.inventory_sha256);
   */
  assemblyReverified(inventorySha256: Sha256Hex): Promise<StructuredReason | undefined> {
    return this.#record({
      provisioning_event: 'PACKAGE_ASSEMBLY_REVERIFIED',
      inventory_sha256: inventorySha256,
      reasons: [],
    });
  }

  /**
   * D4: DescribeStacks gave the stack's unique id, the ownership boundary (BR-RUA-050).
   *
   * @example
   * await journal.stackIdRecorded('arn:aws:cloudformation:us-east-1:123456789012:stack/SucRua-run-3f1c2a9e/…');
   */
  stackIdRecorded(stackId: string): Promise<StructuredReason | undefined> {
    return this.#record({ provisioning_event: 'STACK_ID_RECORDED', stack_id: stackId, reasons: [] });
  }

  async #record(body: ProvisioningEventBody): Promise<StructuredReason | undefined> {
    const causation = this.#previous === undefined ? [] : [this.#previous];
    const appended = await this.#writer.append('provisioning_event_recorded', body, causation);
    if (appended.kind === 'appended') {
      this.#previous = appended.event.event_id;
      return undefined;
    }
    return deploymentReason(
      'PROVISIONING_EVENT_NOT_WRITTEN',
      'BR-RUA-040',
      `${body.provisioning_event} was not appended (${appended.reason}: ${appended.detail}); expected it in ${EXECUTION_PATHS.provisioningJournal}`,
    );
  }
}
