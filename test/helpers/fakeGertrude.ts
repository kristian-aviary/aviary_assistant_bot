import { json, startFake, type FakeServer, type RecordedRequest } from './httpFake.js';

export type GertrudeBehavior =
  | { type: 'ok'; status?: 'created' | 'refreshed'; removed?: boolean; body?: unknown }
  | { type: 'status'; status: number; body?: unknown }
  | { type: 'timeout' }
  | { type: 'reset' };

export const LINK_URL = '/api/internal/teams/reference';
export const REMOVE_URL = '/api/internal/teams/reference/remove';

export type FakeGertrude = FakeServer & {
  behavior: GertrudeBehavior;
  /** Requests that reached the link route (the PUT). */
  linkCalls(): RecordedRequest[];
  removeCalls(): RecordedRequest[];
};

export async function startFakeGertrude(expectedToken: string, initial: GertrudeBehavior = { type: 'ok' }): Promise<FakeGertrude> {
  const holder: { behavior: GertrudeBehavior } = { behavior: initial };
  const server = await startFake((req, res) => {
    const isLink = req.method === 'PUT' && req.url === LINK_URL;
    const isRemove = req.method === 'POST' && req.url === REMOVE_URL;
    if (!isLink && !isRemove) return json(res, 404, { error: 'NOT_FOUND' });
    if (req.headers.authorization !== `Bearer ${expectedToken}`) return json(res, 401, { error: 'UNAUTHORIZED' });
    const b = holder.behavior;
    switch (b.type) {
      case 'ok':
        return json(res, 200, b.body ?? (isLink ? { status: b.status ?? 'created' } : { removed: b.removed ?? true }));
      case 'status':
        return json(res, b.status, b.body ?? { error: 'X' });
      case 'timeout':
        return; // never answer
      case 'reset':
        return res.destroy();
    }
  });
  return Object.defineProperties(server, {
    behavior: { get: () => holder.behavior, set: (v: GertrudeBehavior) => (holder.behavior = v), enumerable: true },
    linkCalls: { value: () => server.requests.filter((r) => r.method === 'PUT' && r.url === LINK_URL) },
    removeCalls: { value: () => server.requests.filter((r) => r.method === 'POST' && r.url === REMOVE_URL) },
  }) as FakeGertrude;
}
