import { HttpBase } from './http.ts';
import type { HttpOptions } from './types.ts';

export class TangledHttp extends HttpBase {
  constructor(hostType?: string, options?: HttpOptions) {
    // The AT Protocol app password is only valid for PDS login, never for
    // appview or knot XRPC endpoints: Bobbin rejects hostRules-derived Basic
    // auth with 401. Authenticated knot writes set an explicit
    // `Authorization: Bearer` service-auth header per request instead, which
    // still applies when `noAuth` is set.
    super(hostType ?? 'tangled', { noAuth: true, ...options });
  }
}
