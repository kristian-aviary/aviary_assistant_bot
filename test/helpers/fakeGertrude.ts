import { json, startFake, type FakeServer } from './httpFake.js';
import { USER_ID } from './constants.js';

export type GertrudeBehavior =
  | { type: 'ok'; userId?: string; body?: unknown }
  | { type: 'status'; status: number; body?: unknown }
  | { type: 'timeout' }
  | { type: 'reset' };

export type FakeGertrude = FakeServer & { behavior: GertrudeBehavior; verifyCalls(): number };

export async function startFakeGertrude(expectedToken: string, initial: GertrudeBehavior = { type: 'ok' }): Promise<FakeGertrude> {
  const holder: { behavior: GertrudeBehavior } = { behavior: initial };
  const server = await startFake((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/internal/teams/verify') return json(res, 404, { error: 'NOT_FOUND' });
    if (req.headers.authorization !== `Bearer ${expectedToken}`) return json(res, 401, { error: 'UNAUTHORIZED' });
    const b = holder.behavior;
    switch (b.type) {
      case 'ok':
        return json(res, 200, b.body ?? { user_id: b.userId ?? USER_ID });
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
    verifyCalls: { value: () => server.requests.filter((r) => r.url === '/api/internal/teams/verify').length },
  }) as FakeGertrude;
}
