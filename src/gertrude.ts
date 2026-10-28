import { z } from 'zod';

export type VerifyInput = { tenantId: string; aadObjectId: string; email: string };
export type VerifyResult =
  | { kind: 'ok'; userId: string }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; code: string };

export interface GertrudeClient {
  verify(input: VerifyInput): Promise<VerifyResult>;
}

const okBody = z.object({ user_id: z.string().min(1).max(512) });

export const VERIFY_TIMEOUT_MS = 5000;

export class HttpGertrudeClient implements GertrudeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = VERIFY_TIMEOUT_MS,
  ) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/internal/teams/verify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: input.tenantId, aad_object_id: input.aadObjectId, email: input.email }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return { kind: 'unavailable', code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }

    try {
      if (res.status === 200) {
        const parsed = okBody.safeParse(await res.json());
        return parsed.success ? { kind: 'ok', userId: parsed.data.user_id } : { kind: 'unavailable', code: 'bad_body' };
      }
      if (res.status === 404) return { kind: 'not_found' };
      if (res.status === 401) return { kind: 'unauthorized' };
      return { kind: 'unavailable', code: `http_${res.status}` };
    } catch {
      return { kind: 'unavailable', code: 'bad_body' };
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  }
}
