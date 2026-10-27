import type { SendHooks, TeamsMessage, TeamsSender, TeamsTarget } from '../../src/teamsSender.js';

export type FakeStep =
  | { type: 'ok'; activityId?: string | null }
  | { type: 'fail'; error: unknown; dispatched?: boolean }
  | { type: 'hang'; dispatched?: boolean }
  | { type: 'gate'; gate: Promise<void>; then?: FakeStep }
  | { type: 'late'; ms: number; outcome: { dispatchBlocked?: boolean; dispatched?: boolean } };

export class FakeTeamsSender implements TeamsSender {
  calls: { target: TeamsTarget; message: TeamsMessage }[] = [];
  private script: FakeStep[] = [];
  private nextId = 1;

  reset(): void {
    this.calls = [];
    this.script = [];
  }

  enqueue(...steps: FakeStep[]): this {
    this.script.push(...steps);
    return this;
  }

  async send(target: TeamsTarget, message: TeamsMessage, hooks: SendHooks): Promise<{ activityId: string | null }> {
    this.calls.push({ target, message });
    const step = this.script.shift() ?? { type: 'ok' as const };
    return this.run(step, hooks);
  }

  private async run(step: FakeStep, hooks: SendHooks): Promise<{ activityId: string | null }> {
    switch (step.type) {
      case 'ok':
        hooks.onDispatched();
        return { activityId: step.activityId === undefined ? `act-${this.nextId++}` : step.activityId };
      case 'fail':
        if (step.dispatched) hooks.onDispatched();
        throw step.error;
      case 'hang':
        if (step.dispatched) hooks.onDispatched();
        return new Promise(() => {});
      case 'late':
        await new Promise((r) => setTimeout(r, step.ms));
        try {
          hooks.onDispatched();
          step.outcome.dispatched = true;
        } catch (err) {
          step.outcome.dispatchBlocked = true;
          throw err;
        }
        return { activityId: 'late' };
      case 'gate':
        hooks.onDispatched();
        await step.gate;
        return this.run(step.then ?? { type: 'ok' }, hooks);
    }
  }
}

export function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, headers } });
}

export function netError(code: string) {
  return Object.assign(new Error(code), { isAxiosError: true, code });
}
