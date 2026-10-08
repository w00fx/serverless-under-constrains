// Lambda binding of `DurableExecutionPort` (BR-RUA-048 step 5, RK-10): running durable executions
// are listed and stopped before the stack is deleted, because a stack cannot delete a function
// with running executions. Thin by construction: each page is one
// `ListDurableExecutionsByFunction` request, read and paged by `sdk-call-outcomes.ts` (bounded,
// with a guard against a repeating cursor); a stop is one `StopDurableExecution`.
//
// An unqualified listing covers only `$LATEST` (client-lambda 3.1146.0
// `ListDurableExecutionsByFunctionRequest.Qualifier`), while the run invokes the Durable caller
// through its alias, so the function is listed unqualified and under every version qualifier the
// resource manifest records for it (`discovery-targets.ts`).
//
// UNVERIFIED (cloud phase): the error a stop of an execution that ended meanwhile answers. A
// refused stop is therefore followed by `GetDurableExecution`: a status other than `RUNNING`
// reads not running.

import {
  GetDurableExecutionCommand,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import type { DurableExecutionListing, DurableExecutionPort, DurableStopOutcome } from '../cleanup-ports.ts';
import type { DurableFunctionTarget } from '../discovery-targets.ts';
import type { Described } from '../sdk-call-outcomes.ts';
import {
  described,
  describedPages,
  durableStopOutcome,
  itemsOrNone,
  settleCleanupCall,
  stopNeedsStatusRead,
} from '../sdk-call-outcomes.ts';
import type { Page, Reading } from '../surface-readings.ts';
import { durableStatusReading, runningExecutionArnsPage } from '../surface-readings-lambda.ts';

/**
 * Every listed execution of one Durable function, unqualified and under each qualifier, in the
 * form `readPage` reads them; none when the function is gone.
 *
 * @example
 * await listDurableExecutions(lambda, { function_name: name, qualifiers: ['3'] }, runningExecutionArnsPage);
 */
export async function listDurableExecutions<T>(
  lambda: LambdaClient,
  target: DurableFunctionTarget,
  readPage: (output: unknown) => Reading<Page<T>>,
): Promise<Reading<readonly T[]>> {
  const found: T[] = [];
  for (const qualifier of [undefined, ...target.qualifiers]) {
    const listing = await describedPages(
      (cursor) =>
        settleCleanupCall(() =>
          lambda.send(
            new ListDurableExecutionsByFunctionCommand({
              FunctionName: target.function_name,
              Qualifier: qualifier,
              Statuses: ['RUNNING'],
              Marker: cursor,
            }),
          ),
        ),
      readPage,
      qualifier === undefined ? target.function_name : `${target.function_name}:${qualifier}`,
      'a listing of running durable executions',
    );
    const items = itemsOrNone(listing);
    if (!items.ok) {
      return items;
    }
    found.push(...items.value);
  }
  return { ok: true, value: found };
}

/**
 * Durable executions through Lambda, bound to the Durable functions of one execution.
 *
 * @example
 * const durable = new LambdaDurableExecutions(clients.lambda, targets.durable_functions);
 * await durable.listRunning(functionName); // { ok: true, running_execution_arns: [...] }
 */
export class LambdaDurableExecutions implements DurableExecutionPort {
  readonly #lambda: LambdaClient;
  readonly #functions: readonly DurableFunctionTarget[];

  constructor(lambda: LambdaClient, functions: readonly DurableFunctionTarget[]) {
    this.#lambda = lambda;
    this.#functions = functions;
  }

  /** The ARNs of the function's `RUNNING` executions, under every bound qualifier. */
  async listRunning(functionName: string): Promise<DurableExecutionListing> {
    const bound = this.#functions.find((target) => target.function_name === functionName);
    const target = bound ?? { function_name: functionName, qualifiers: [] };
    const arns = await listDurableExecutions(this.#lambda, target, runningExecutionArnsPage);
    return arns.ok ? { ok: true, running_execution_arns: [...new Set(arns.value)] } : { ok: false, reason: arns.error };
  }

  /** Stops one execution; one that ended or is gone is not running. */
  async stop(executionArn: string): Promise<DurableStopOutcome> {
    const stop = await settleCleanupCall(() =>
      this.#lambda.send(new StopDurableExecutionCommand({ DurableExecutionArn: executionArn })),
    );
    const status = stopNeedsStatusRead(stop) ? await this.#readStatus(executionArn) : undefined;
    return durableStopOutcome(stop, status, executionArn);
  }

  async #readStatus(executionArn: string): Promise<Described<string>> {
    const call = await settleCleanupCall(() =>
      this.#lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: executionArn })),
    );
    return described(call, durableStatusReading, executionArn, 'the durable execution status');
  }
}
