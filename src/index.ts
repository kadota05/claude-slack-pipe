import { createApp, startApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AuthMiddleware } from './middleware/auth.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { ProjectStore } from './store/project-store.js';
import { SessionStore } from './store/session-store.js';
import { SessionManager } from './bridge/session-manager.js';
import { ProcessManager } from './bridge/process-manager.js';
import { Executor } from './bridge/executor.js';
import { EventRouter } from './slack/event-handler.js';
import { ReactionManager } from './slack/reaction-manager.js';
import { ErrorDisplayHandler } from './slack/error-handler.js';
import { BridgeCommandHandler } from './slack/bridge-commands.js';
import { HomeTabHandler } from './slack/home-tab.js';
import { sanitizeUserInput } from './utils/sanitizer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);

  // Initialize stores
  const projectStore = new ProjectStore(config.claudeProjectsDir);
  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore, projectStore);

  // Initialize process management
  const processManager = new ProcessManager({
    maxConcurrentPerUser: config.maxConcurrentPerUser,
    maxConcurrentGlobal: config.maxConcurrentGlobal,
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxTimeoutMs: config.maxTimeoutMs,
    defaultBudgetUsd: config.defaultBudgetUsd,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  const executor = new Executor({ claudeExecutable: config.claudeExecutable });

  // Initialize middleware
  const auth = new AuthMiddleware({
    allowedUserIds: config.allowedUserIds,
    allowedTeamIds: config.allowedTeamIds,
    adminUserIds: config.adminUserIds,
  });
  const rateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });

  // Initialize Slack handlers
  const reactionManager = new ReactionManager(app.client);
  const errorHandler = new ErrorDisplayHandler(app.client);
  const bridgeCommands = new BridgeCommandHandler(sessionStore, app.client);
  const homeTab = new HomeTabHandler(projectStore, sessionStore);

  // Event router
  const router = new EventRouter({
    onPrompt: async (msg) => {
      // Auth + Rate limit check
      if (!auth.isAllowed(msg.userId)) {
        logger.warn('Unauthorized user', { userId: msg.userId });
        return;
      }
      const rateResult = rateLimiter.check(msg.userId);
      if (!rateResult.allowed) {
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: `Rate limited. Please wait ${Math.ceil((rateResult.retryAfterMs || 0) / 1000)}s.`,
        });
        return;
      }

      // Concurrency check
      if (!processManager.canStart(msg.userId)) {
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: 'You already have a running session. Please wait for it to complete or use `cc /end`.',
        });
        return;
      }

      // Resolve or create session
      // For MVP, use first project as default
      const projects = projectStore.getProjects();
      const defaultProject = projects[0];
      const projectPath = defaultProject?.projectPath || config.claudeProjectsDir;
      const projectName = projectPath.split('/').pop() || 'project';

      const session = sessionManager.resolveOrCreate({
        threadTs: msg.threadTs,
        dmChannelId: msg.channelId,
        projectPath,
        name: `${projectName}: ${msg.text.substring(0, 30)}`,
        model: 'sonnet',
      });

      // Add processing reaction
      await reactionManager.addProcessing(msg.channelId, msg.messageTs);

      // Execute
      const isResume = session.turnCount > 0;
      try {
        const sanitizedPrompt = sanitizeUserInput(msg.text);
        const { process: child, result: resultPromise } = executor.spawn(
          session,
          sanitizedPrompt,
          isResume,
          { budgetUsd: config.defaultBudgetUsd },
        );

        // Register process for management
        processManager.register({
          sessionId: session.sessionId,
          userId: msg.userId,
          channelId: msg.channelId,
          projectId: defaultProject?.id || 'default',
          process: child,
          budgetUsd: config.defaultBudgetUsd,
          timeoutMs: config.defaultTimeoutMs,
        });

        const result = await resultPromise;

        // Record turn
        sessionManager.recordTurn(session.sessionId, {
          costUsd: result.output.total_cost_usd,
          inputTokens: 0, // MVP: not available from json output
          outputTokens: 0,
        });

        // Post result
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: result.output.result,
        });

        await reactionManager.replaceWithSuccess(msg.channelId, msg.messageTs);
      } catch (err) {
        await reactionManager.replaceWithError(msg.channelId, msg.messageTs);
        await errorHandler.displayError({
          error: err as Error,
          channelId: msg.channelId,
          threadTs: msg.threadTs,
        });
      }
    },

    onCommand: async (msg) => {
      if (!auth.isAllowed(msg.userId)) return;

      if (msg.parsed.type === 'bridge_command' && msg.parsed.command) {
        await bridgeCommands.dispatch(
          msg.parsed.command,
          msg.parsed.args,
          msg.channelId,
          msg.threadTs,
        );
      } else if (msg.parsed.type === 'claude_command') {
        // Forward as prompt: "/<command> <args>"
        const promptText = `/${msg.parsed.command}${msg.parsed.args ? ` ${msg.parsed.args}` : ''}`;
        await router.handleMessage({
          text: promptText,
          user: msg.userId,
          channel: msg.channelId,
          ts: msg.messageTs,
          thread_ts: msg.threadTs,
        });
      }
    },
  });

  // Register Bolt event handlers
  app.event('message', async ({ event }) => {
    if (event.channel_type !== 'im') return;
    await router.handleMessage(event as any);
  });

  app.event('app_home_opened', async ({ event }) => {
    await homeTab.publishHomeTab(app.client, event.user);
  });

  // Start
  await startApp(app);
  logger.info('Claude Code Slack Bridge is running');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await processManager.killAll();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
