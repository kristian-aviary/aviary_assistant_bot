import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startService } from './server.js';

const logger = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    logger.critical('config_invalid', { code: 'CONFIG_INVALID' });
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const service = await startService(config, logger);

let signalled = false;
const shutdown = (signal: string) => {
  if (signalled) {
    logger.warn('shutdown_forced', { status: signal });
    process.exit(1);
  }
  signalled = true;
  logger.info('shutdown_started', { status: signal });
  service.stop().then(
    () => {
      logger.info('shutdown_complete');
      process.exit(0);
    },
    () => {
      logger.error('shutdown_failed', { code: 'STOP_ERROR' });
      process.exit(1);
    },
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
