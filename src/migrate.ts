import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool);
  logger.info('migrations_applied', { count: applied.length });
} finally {
  await pool.end();
}
