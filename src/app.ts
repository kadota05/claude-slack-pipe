import { App, LogLevel } from '@slack/bolt';
import type { SocketModeClient } from '@slack/socket-mode';
import { loadConfig, type AppConfig } from './config.js';
import { logger } from './utils/logger.js';

const logLevelMap: Record<string, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

const CLIENT_PING_TIMEOUT_MS = 30_000;
const SERVER_PING_TIMEOUT_MS = 30_000;

export function createApp(config?: AppConfig): App {
  const cfg = config ?? loadConfig();
  const app = new App({
    token: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    socketMode: true,
    logLevel: logLevelMap[cfg.logLevel] || LogLevel.INFO,
  });

  // Tune Socket Mode ping/pong timeouts to avoid false-positive disconnections.
  // Default clientPingTimeout is 5s, which triggers spurious reconnects on slower networks.
  const socketClient = (app as any).receiver?.client as SocketModeClient | undefined;
  if (socketClient) {
    (socketClient as any).clientPingTimeoutMS = CLIENT_PING_TIMEOUT_MS;
    (socketClient as any).serverPingTimeoutMS = SERVER_PING_TIMEOUT_MS;
    (socketClient as any).pingPongLoggingEnabled = true;
    logger.info('Socket Mode ping/pong tuned', {
      clientPingTimeoutMS: CLIENT_PING_TIMEOUT_MS,
      serverPingTimeoutMS: SERVER_PING_TIMEOUT_MS,
    });
  }

  logger.info('Bolt app created with Socket Mode');
  return app;
}

export async function startApp(app: App): Promise<void> {
  await app.start();
  logger.info('Bolt app started successfully');
}
