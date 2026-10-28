import { z } from 'zod';

const required = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);

const httpUrl = (name: string) =>
  required(name).refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    `${name} must be an http(s) URL`,
  );

const schema = z.object({
  DATABASE_URL: required('DATABASE_URL'),
  GERTRUDE_URL: httpUrl('GERTRUDE_URL'),
  GERTRUDE_VERIFY_TOKEN: required('GERTRUDE_VERIFY_TOKEN'),
  SEND_SERVICE_TOKEN: required('SEND_SERVICE_TOKEN'),
  CLIENT_ID: required('CLIENT_ID'),
  CLIENT_SECRET: required('CLIENT_SECRET'),
  TENANT_ID: required('TENANT_ID'),
  PORT: z.coerce
    .number({ error: 'PORT must be a number' })
    .int('PORT must be an integer')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3978),
  SERVICE_URL_ALLOWED_HOSTS: z.string().optional(),
});

export type Config = {
  databaseUrl: string;
  gertrudeUrl: string;
  gertrudeVerifyToken: string;
  sendServiceToken: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  port: number;
  extraServiceUrlHosts: string[];
};

export class ConfigError extends Error {
  readonly variables: string[];
  constructor(variables: string[], problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

/**
 * Reads and validates the environment. Problems name the variable only; the
 * value is never echoed (zod messages here are all static strings).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = env[key];
    raw[key] = v === undefined || v.trim() === '' ? undefined : v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const variables: string[] = [];
    const problems: string[] = [];
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'config');
      if (!variables.includes(name)) variables.push(name);
      const missing = raw[name] === undefined;
      problems.push(missing ? `missing ${name}` : `invalid ${name} (${staticReason(name)})`);
    }
    throw new ConfigError(variables, [...new Set(problems)]);
  }
  const v = parsed.data;
  if (v.SEND_SERVICE_TOKEN === v.GERTRUDE_VERIFY_TOKEN) {
    throw new ConfigError(
      ['SEND_SERVICE_TOKEN', 'GERTRUDE_VERIFY_TOKEN'],
      ['SEND_SERVICE_TOKEN and GERTRUDE_VERIFY_TOKEN must be different values (one token per direction)'],
    );
  }
  return {
    databaseUrl: v.DATABASE_URL,
    gertrudeUrl: v.GERTRUDE_URL.replace(/\/+$/, ''),
    gertrudeVerifyToken: v.GERTRUDE_VERIFY_TOKEN,
    sendServiceToken: v.SEND_SERVICE_TOKEN,
    clientId: v.CLIENT_ID,
    clientSecret: v.CLIENT_SECRET,
    tenantId: v.TENANT_ID,
    port: v.PORT,
    extraServiceUrlHosts: (v.SERVICE_URL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}

function staticReason(name: string): string {
  switch (name) {
    case 'GERTRUDE_URL':
      return 'must be an http(s) URL';
    case 'PORT':
      return 'must be an integer from 1 to 65535';
    default:
      return 'rejected';
  }
}
