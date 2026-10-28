import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AjvModule from 'ajv-draft-04';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MANIFEST_VERSION, TEAMS_APP_ID, buildManifest } from '../scripts/lib/manifest.js';

type AjvCtor = new (opts: Record<string, unknown>) => { compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown[] | null } };
const Ajv = ((AjvModule as unknown as { default?: AjvCtor }).default ?? AjvModule) as unknown as AjvCtor;
const root = path.resolve(import.meta.dirname, '..');
const BOT_ID = '11111111-2222-4333-8444-555555555555';

describe('Teams app manifest', () => {
  const manifest = buildManifest({ botId: BOT_ID });

  it('validates against the committed copy of the current Microsoft schema', () => {
    const schema = JSON.parse(readFileSync(path.join(root, 'appPackage/schema', `MicrosoftTeams.v${MANIFEST_VERSION}.schema.json`), 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    const ok = validate(manifest);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    // negative controls: the schema is really being enforced
    expect(validate({ ...manifest, id: 'not-a-guid' })).toBe(false);
    expect(validate({ ...manifest, icons: undefined })).toBe(false);
    expect(validate({ ...manifest, bots: [{ ...(manifest.bots as object[])[0], scopes: ['nowhere'] }] })).toBe(false);
  });

  it('uses the current schema version', () => {
    expect(manifest.manifestVersion).toBe('1.30');
    expect(String(manifest.$schema)).toContain('/v1.30/');
  });

  it('is a personal-scope-only bot named "Aviary Assistant"', () => {
    expect(manifest.name).toEqual({ short: 'Aviary Assistant', full: 'Aviary Assistant' });
    const bots = manifest.bots as { botId: string; scopes: string[] }[];
    expect(bots).toHaveLength(1);
    expect(bots[0]!.botId).toBe(BOT_ID);
    expect(bots[0]!.scopes).toEqual(['personal']);
  });

  it('has no webApplicationInfo, no resource-specific consent and no ChannelMessage.Read.Group', () => {
    const text = JSON.stringify(manifest);
    expect(manifest).not.toHaveProperty('webApplicationInfo');
    expect(manifest).not.toHaveProperty('authorization');
    expect(manifest).not.toHaveProperty('permissions');
    expect(text).not.toContain('ChannelMessage.Read.Group');
    expect(text).not.toContain('resourceSpecific');
    expect(text).not.toContain('groupChat');
    expect(text).not.toContain('"team"');
  });

  it('has empty validDomains and no tabs, extensions or composeExtensions', () => {
    expect(manifest.validDomains).toEqual([]);
    for (const k of ['staticTabs', 'configurableTabs', 'composeExtensions', 'activities', 'devicePermissions']) {
      expect(manifest).not.toHaveProperty(k);
    }
  });

  it('carries a fresh app id of our own that is a v4 UUID and differs from the bot id', () => {
    expect(manifest.id).toBe(TEAMS_APP_ID);
    expect(TEAMS_APP_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(TEAMS_APP_ID).not.toBe(BOT_ID);
  });

  it('the app id can be overridden (registration routes that assign their own id) and must be a GUID', () => {
    const other = '22222222-3333-4444-8555-666666666666';
    expect(buildManifest({ botId: BOT_ID, appId: other }).id).toBe(other);
    expect(() => buildManifest({ botId: BOT_ID, appId: 'nope' })).toThrow(/appId/);
  });

  it('refuses a bot id that is not a GUID', () => {
    expect(() => buildManifest({ botId: 'not-a-guid' })).toThrow(/GUID/);
  });
});

describe('npm run package:app', () => {
  it('builds a zip with manifest.json and the two placeholder icons at the sizes Teams expects', () => {
    execFileSync('npx', ['tsx', 'scripts/package-app.ts'], { cwd: root, env: { ...process.env, CLIENT_ID: BOT_ID }, stdio: 'pipe' });
    const files = unzipSync(new Uint8Array(readFileSync(path.join(root, 'appPackage/build/aviary-assistant.zip'))));
    expect(Object.keys(files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png']);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'));
    expect(manifest.bots[0].botId).toBe(BOT_ID);
    const dims = (name: string) => {
      const b = Buffer.from(files[name]!);
      expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    expect(dims('color.png')).toEqual([192, 192]);
    expect(dims('outline.png')).toEqual([32, 32]);
  });

  it('fails with a clear message when CLIENT_ID is missing', () => {
    const env = { ...process.env };
    delete env.CLIENT_ID;
    expect(() => execFileSync('npx', ['tsx', 'scripts/package-app.ts'], { cwd: root, env, stdio: 'pipe' })).toThrow(/CLIENT_ID is required/);
  });
});
