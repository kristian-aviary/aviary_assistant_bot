import { json, startFake, type FakeServer, type RecordedRequest } from './httpFake.js';
import { TEAMS_USER_ID, USER_AAD_ID, USER_EMAIL, USER_TENANT_ID } from './constants.js';

export type ConnectorBehavior =
  | { type: 'ok'; id?: string }
  | { type: 'status'; status: number; headers?: Record<string, string> }
  | { type: 'reset' }
  | { type: 'hang' };

export type FakeConnector = FakeServer & {
  activityBehavior: ConnectorBehavior;
  member: Record<string, unknown>;
  memberStatus: number;
  activities(): RecordedRequest[];
};

/** Stands in for the Bot Framework connector at the user's service URL (path prefix /emea). */
export async function startFakeConnector(): Promise<FakeConnector> {
  const state = {
    activityBehavior: { type: 'ok' } as ConnectorBehavior,
    member: { id: TEAMS_USER_ID, name: 'Some One', aadObjectId: USER_AAD_ID, email: USER_EMAIL, tenantId: USER_TENANT_ID } as Record<string, unknown>,
    memberStatus: 200,
  };
  let seq = 0;
  const server = await startFake((req, res) => {
    const activity = /^\/emea\/v3\/conversations\/([^/]+)\/activities$/.exec(req.url);
    if (req.method === 'POST' && activity) {
      const b = state.activityBehavior;
      switch (b.type) {
        case 'ok':
          return json(res, 201, { id: b.id ?? `connector-act-${++seq}` });
        case 'status':
          return json(res, b.status, { error: { code: 'X', message: 'x' } }, b.headers);
        case 'reset':
          return res.destroy();
        case 'hang':
          return;
      }
    }
    const member = /^\/emea\/v3\/conversations\/([^/]+)\/members\/([^/]+)$/.exec(req.url);
    if (req.method === 'GET' && member) {
      return state.memberStatus === 200 ? json(res, 200, state.member) : json(res, state.memberStatus, { error: 'x' });
    }
    return json(res, 404, { error: 'no such route' });
  });
  return Object.defineProperties(server, {
    activityBehavior: { get: () => state.activityBehavior, set: (v: ConnectorBehavior) => (state.activityBehavior = v), enumerable: true },
    member: { get: () => state.member, set: (v: Record<string, unknown>) => (state.member = v), enumerable: true },
    memberStatus: { get: () => state.memberStatus, set: (v: number) => (state.memberStatus = v), enumerable: true },
    activities: { value: () => server.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/activities')) },
  }) as FakeConnector;
}
