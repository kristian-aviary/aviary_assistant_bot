/**
 * Builds the Teams app package (manifest.json + icons, zipped).
 *
 *   CLIENT_ID=<bot app id> npm run package:app
 *
 * Optional: APP_ID (override the Teams app id), APP_VERSION, APP_DEVELOPER_NAME, APP_WEBSITE_URL,
 * APP_PRIVACY_URL, APP_TERMS_URL.
 * Output (git-ignored): appPackage/build/{manifest.json, color.png, outline.png, aviary-assistant.zip}.
 * The icons are generated placeholders; design will supply real ones.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { buildManifest } from './lib/manifest.js';
import { colorIcon, outlineIcon } from './lib/png.js';

const outDir = path.resolve(import.meta.dirname, '..', 'appPackage', 'build');
mkdirSync(outDir, { recursive: true });

const botId = process.env.CLIENT_ID?.trim();
if (!botId) {
  process.stderr.write('CLIENT_ID is required: the Entra app (client) id of the bot registration.\n');
  process.exit(1);
}

const manifest = buildManifest({
  botId,
  appId: process.env.APP_ID?.trim() || undefined,
  appVersion: process.env.APP_VERSION,
  developerName: process.env.APP_DEVELOPER_NAME,
  websiteUrl: process.env.APP_WEBSITE_URL,
  privacyUrl: process.env.APP_PRIVACY_URL,
  termsOfUseUrl: process.env.APP_TERMS_URL,
});

const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(path.join(outDir, 'manifest.json'), manifestJson);
const color = colorIcon();
const outline = outlineIcon();
writeFileSync(path.join(outDir, 'color.png'), color);
writeFileSync(path.join(outDir, 'outline.png'), outline);

const zip = zipSync(
  {
    'manifest.json': Buffer.from(manifestJson, 'utf8'),
    'color.png': [color, { level: 0 }],
    'outline.png': [outline, { level: 0 }],
  },
  { mtime: new Date('2026-01-01T00:00:00Z') },
);
const target = path.join(outDir, 'aviary-assistant.zip');
writeFileSync(target, zip);
process.stdout.write(`wrote ${path.relative(process.cwd(), target)} (${zip.length} bytes)\n`);
