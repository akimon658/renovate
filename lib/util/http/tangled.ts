import { HttpBase } from './http.ts';
import type { HttpOptions } from './types.ts';

export class TangledHttp extends HttpBase {
  constructor(hostType?: string, options?: HttpOptions) {
    super(hostType ?? 'tangled', options);
  }
}
