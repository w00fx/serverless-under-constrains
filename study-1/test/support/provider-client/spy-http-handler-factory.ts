// A spying HttpHandlerFactory (design §12.2, §9.13 cases 1 and 3; CF V-2): it records the options
// the provider client asked for and returns a RecordingHttpHandler, so a test can assert the
// handler options at the factory (NodeHttpHandler hides them until the first request) and that
// the client really uses the factory's instance.

import type { ProviderHttpHandlerOptions } from '../../../src/provider-client/transport-options.ts';
import { RecordingHttpHandler } from './recording-http-handler.ts';

export class SpyHttpHandlerFactory {
  readonly #options: ProviderHttpHandlerOptions[] = [];
  readonly #handlers: RecordingHttpHandler[] = [];

  /** The factory function itself, bound so it can be passed as `HttpHandlerFactory`. */
  readonly create = (options: ProviderHttpHandlerOptions): RecordingHttpHandler => {
    this.#options.push(options);
    const handler = new RecordingHttpHandler();
    this.#handlers.push(handler);
    return handler;
  };

  /** The options of every call, in order. */
  receivedOptions(): readonly ProviderHttpHandlerOptions[] {
    return [...this.#options];
  }

  /** The handlers created, in order. */
  handlers(): readonly RecordingHttpHandler[] {
    return [...this.#handlers];
  }

  /** The only handler created; throws when the factory was called zero or several times. */
  onlyHandler(): RecordingHttpHandler {
    const [handler, ...others] = this.#handlers;
    if (handler === undefined || others.length > 0) {
      throw new Error(`factory created ${String(this.#handlers.length)} handler(s); expected exactly one`);
    }
    return handler;
  }
}
