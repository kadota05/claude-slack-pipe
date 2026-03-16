import { App, LogLevel } from '@slack/bolt';
import { loadConfig, type AppConfig } from './config.js';
import { logger } from './utils/logger.js';

const logLevelMap: Record<string, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

export function createApp(config?: AppConfig): App {
  const cfg = config ?? loadConfig();
  const app = new App({
    token: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    socketMode: true,
    logLevel: logLevelMap[cfg.logLevel] || LogLevel.INFO,
  });
  logger.info('Bolt app created with Socket Mode');
  return app;
}

export async function startApp(app: App): Promise<void> {
  await app.start();
  logger.info('Bolt app started successfully');
}
