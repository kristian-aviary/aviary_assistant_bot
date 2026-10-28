import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const self = path.relative(root, import.meta.filename);

/** The retired database pieces, matched case-insensitively. This file builds them from parts so it can scan itself out. */
const FORBIDDEN = new RegExp(`\\b${'p'}${'g'}\\b|${'DATABASE'}_${'URL'}|${'migra'}t`, 'i');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function trackedScripts(): string[] {
  // Only committed scripts: git-excluded local harnesses are not part of the repo.
  const out = execFileSync('git', ['ls-files', '--', 'scripts'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((f) => path.join(root, f));
}

describe('the bot is stateless: no database left anywhere', () => {
  const files = [
    ...walk(path.join(root, 'src')),
    ...trackedScripts(),
    ...walk(path.join(root, 'test')),
    path.join(root, 'Dockerfile'),
    path.join(root, 'package.json'),
  ].filter((f) => path.relative(root, f) !== self);

  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(25);
    for (const dir of ['src', 'scripts', 'test']) expect(files.some((f) => f.startsWith(path.join(root, dir) + path.sep))).toBe(true);
  });

  it('no file under src/, tracked scripts/, test/, nor the Dockerfile or package.json mentions the old database pieces', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`${path.relative(root, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the database files and folders are gone', () => {
    for (const gone of ['src/db.ts', 'src/migrate.ts', 'migrations', 'test/helpers/pg.ts', 'test/repositories.test.ts']) {
      expect(existsSync(path.join(root, gone)), gone).toBe(false);
    }
  });

  it('package.json has no database dependency and no migrate script; the lockfile has no pg package', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.scripts ?? {})];
    expect(names.filter((n) => FORBIDDEN.test(n))).toEqual([]);
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((n) => /node_modules\/(@types\/)?pg(-|$)/.test(n))).toEqual([]);
  });
});
