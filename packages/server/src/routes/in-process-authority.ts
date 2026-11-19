/**
 * In-process service authority (WO-HARNESS-T3-COMMAND-CONSUMER-01).
 *
 * Requests built by createInProcessApiFetch are dispatched straight into this
 * process's own router (app.fetch) -- no socket, no network self-call, and no
 * operator token. Membership in this WeakSet is the authority: a Request object
 * can only be added here by code running inside this process, so nothing that
 * arrives over the network can ever match. The /api auth middleware admits a
 * member as the server's own internal caller. Every network request is
 * classified exactly as before.
 */
const inProcessServiceRequests = new WeakSet<Request>();

/** True only for a Request built by createInProcessApiFetch in this process. */
export function isInProcessServiceRequest(request: Request): boolean {
  return inProcessServiceRequests.has(request);
}

/** The in-process Request origin; never resolved, never dialed. */
export const IN_PROCESS_API_ORIGIN = 'http://archon.in-process';

/**
 * Build a fetch-compatible function that executes Archon API requests inside
 * this process with the server's own authority. Used by the cauldron-fire
 * consumer to run the cascade without an HTTP self-call or the operator token.
 */
export function createInProcessApiFetch(app: {
  fetch: (request: Request) => Response | Promise<Response>;
}): typeof fetch {
  const inProcessFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    if (new URL(request.url).origin !== IN_PROCESS_API_ORIGIN) {
      throw new Error('in_process_api_fetch_origin_refused');
    }
    // Principal headers are never honored on the in-process path.
    request.headers.delete('x-dispatch-principal-id');
    request.headers.delete('x-dispatch-principal-token');
    inProcessServiceRequests.add(request);
    return app.fetch(request);
  };
  return inProcessFetch as typeof fetch;
}
