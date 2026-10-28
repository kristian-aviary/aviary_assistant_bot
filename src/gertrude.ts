import { z } from 'zod';

export type LinkInput = {
  tenantId: string;
  aadObjectId: string;
  email: string;
  conversationId: string;
  /** Already normalized and allow-listed. */
  serviceUrl: string;
  reference: Record<string, unknown>;
};
export type RemoveInput = { tenantId: string; aadObjectId: string };

/** Expected statuses are values, never exceptions. */
export type LinkResult =
  | { kind: 'created' }
  | { kind: 'refreshed' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'unauthorized' }
  | { kind: 'bad_request' }
  | { kind: 'unavailable'; code: string };

export type RemoveResult =
  | { kind: 'removed'; removed: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'bad_request' }
  | { kind: 'unavailable'; code: string };

export interface GertrudeClient {
  linkReference(input: LinkInput): Promise<LinkResult>;
  removeReference(input: RemoveInput): Promise<RemoveResult>;
}

const linkOkBody = z.object({ status: z.enum(['created', 'refreshed']) });
const removeOkBody = z.object({ removed: z.boolean() });

export const GERTRUDE_TIMEOUT_MS = 5000;
export const LINK_PATH = '/api/internal/teams/reference';
export const REMOVE_PATH = '/api/internal/teams/reference/remove';

export class HttpGertrudeClient implements GertrudeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = GERTRUDE_TIMEOUT_MS,
  ) {}

  async linkReference(input: LinkInput): Promise<LinkResult> {
    return this.call(
      'PUT',
      LINK_PATH,
      {
        tenant_id: input.tenantId,
        aad_object_id: input.aadObjectId,
        email: input.email,
        conversation_id: input.conversationId,
        service_url: input.serviceUrl,
        reference: input.reference,
      },
      async (status, readBody): Promise<LinkResult> => {
        if (status === 200) {
          const parsed = linkOkBody.safeParse(await readBody());
          return parsed.success ? { kind: parsed.data.status } : { kind: 'unavailable', code: 'bad_body' };
        }
        if (status === 404) return { kind: 'not_found' };
        if (status === 409) return { kind: 'conflict' };
        if (status === 401) return { kind: 'unauthorized' };
        if (status === 400) return { kind: 'bad_request' };
        return { kind: 'unavailable', code: `http_${status}` };
      },
      (code): LinkResult => ({ kind: 'unavailable', code }),
    );
  }

  async removeReference(input: RemoveInput): Promise<RemoveResult> {
    return this.call(
      'POST',
      REMOVE_PATH,
      { tenant_id: input.tenantId, aad_object_id: input.aadObjectId },
      async (status, readBody): Promise<RemoveResult> => {
        if (status === 200) {
          const parsed = removeOkBody.safeParse(await readBody());
          return parsed.success ? { kind: 'removed', removed: parsed.data.removed } : { kind: 'unavailable', code: 'bad_body' };
        }
        if (status === 401) return { kind: 'unauthorized' };
        if (status === 400) return { kind: 'bad_request' };
        return { kind: 'unavailable', code: `http_${status}` };
      },
      (code): RemoveResult => ({ kind: 'unavailable', code }),
    );
  }

  private async call<T>(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    classify: (status: number, readBody: () => Promise<unknown>) => Promise<T>,
    failed: (code: string) => T,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return failed(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }

    try {
      return await classify(res.status, () => res.json());
    } catch {
      return failed('bad_body');
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  }
}
