import { createApp, startApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AuthMiddleware } from './middleware/auth.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { ProjectStore } from './store/project-store.js';
import { UserPreferenceStore } from './store/user-preference-store.js';
import { SessionIndexStore } from './store/session-index-store.js';
import { SessionCoordinator } from './bridge/session-coordinator.js';
import { ReactionManager } from './slack/reaction-manager.js';
import { ErrorDisplayHandler } from './slack/error-handler.js';
import { BridgeCommandHandler } from './slack/bridge-commands.js';
import { HomeTabHandler } from './slack/home-tab.js';
import { ActionHandler } from './slack/action-handler.js';
import { parseCommand } from './slack/command-parser.js';
import { parsePermissionAction } from './slack/permission-prompt.js';
import { sanitizeUserInput } from './utils/sanitizer.js';
import { buildResponseFooter, buildThreadHeaderText } from './slack/block-builder.js';
import fs from 'node:fs';
import type { PersistentSession } from './bridge/persistent-session.js';
import { StreamProcessor } from './streaming/stream-processor.js';
import { SlackActionExecutor } from './streaming/slack-action-executor.js';

function waitForIdle(session: PersistentSession, timeoutMs = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (session.state === 'idle') { resolve(); return; }
    logger.info(`[waitForIdle] waiting for session ${session.sessionId}, current state: ${session.state}`);
    const timer = setTimeout(() => {
      logger.error(`[waitForIdle] timeout after ${timeoutMs}ms, state: ${session.state}`);
      reject(new Error('Session init timeout'));
    }, timeoutMs);
    session.on('stateChange', (_from: string, to: string) => {
      logger.info(`[waitForIdle] stateChange: ${_from} → ${to}`);
      if (to === 'idle') { clearTimeout(timer); resolve(); }
      if (to === 'dead') { clearTimeout(timer); reject(new Error('Session died during init')); }
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = createApp(config);

  // Initialize stores
  const projectStore = new ProjectStore(config.claudeProjectsDir);
  const userPrefStore = new UserPreferenceStore(config.dataDir);
  const sessionIndexStore = new SessionIndexStore(config.dataDir);

  // Initialize process coordination
  const coordinator = new SessionCoordinator({
    maxAlivePerUser: config.maxConcurrentPerUser,
    maxAliveGlobal: config.maxConcurrentGlobal,
  });

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
  const bridgeCommands = new BridgeCommandHandler(app.client);
  const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, sessionIndexStore, projectStore);
  const actionHandler = new ActionHandler(userPrefStore, coordinator, homeTabHandler);

  // --- Message Handler ---
  async function handleMessage(event: any): Promise<void> {
    logger.info('[DEBUG] handleMessage called', { type: event.type, channel_type: event.channel_type, bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 50), user: event.user });
    if (event.channel_type !== 'im') { logger.info('[DEBUG] skipped: not im'); return; }
    if (event.bot_id || event.subtype) { logger.info('[DEBUG] skipped: bot_id or subtype', { bot_id: event.bot_id, subtype: event.subtype }); return; }

    const userId = event.user;
    const channelId = event.channel;
    const messageTs = event.ts;
    const threadTs = event.thread_ts || event.ts;
    const text = sanitizeUserInput(event.text || '');

    logger.info('[DEBUG] auth check', { userId, allowed: auth.isAllowed(userId) });
    // Auth + Rate limit
    if (!auth.isAllowed(userId)) {
      logger.warn('Unauthorized user', { userId });
      return;
    }
    const rateResult = rateLimiter.check(userId);
    if (!rateResult.allowed) {
      await app.client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Rate limited. Please wait ${Math.ceil((rateResult.retryAfterMs || 0) / 1000)}s.`,
      });
      return;
    }

    // Parse command
    const parsed = parseCommand(text);

    // Bot commands
    if (parsed.type === 'bot_command') {
      const indexEntry = sessionIndexStore.findByThreadTs(threadTs);
      if (parsed.command === 'status') {
        const session = indexEntry ? coordinator.getSession(indexEntry.cliSessionId) : undefined;
        await bridgeCommands.handleStatus({
          channelId,
          threadTs,
          userId,
          sessionInfo: {
            sessionId: indexEntry?.cliSessionId || 'N/A',
            model: indexEntry?.model || 'N/A',
            projectPath: indexEntry?.projectPath || 'N/A',
            totalCost: 0,
            totalTokens: 0,
            turnCount: 0,
            processState: session?.state || 'N/A',
            startedAt: indexEntry?.createdAt || 'N/A',
          },
        });
      } else if (parsed.command === 'end') {
        if (indexEntry) {
          await bridgeCommands.handleEnd({
            channelId,
            threadTs,
            userId,
            sessionId: indexEntry.cliSessionId,
            totalCost: 0,
            totalTokens: 0,
            turnCount: 0,
            duration: 'N/A',
            onEnd: async () => {
              coordinator.endSession(indexEntry.cliSessionId);
              sessionIndexStore.update(indexEntry.cliSessionId, { status: 'ended' });
            },
          });
        }
      } else if (parsed.command === 'restart') {
        if (indexEntry) {
          await bridgeCommands.handleRestart({
            channelId,
            threadTs,
            userId,
            sessionId: indexEntry.cliSessionId,
            onRestart: async () => {
              coordinator.endSession(indexEntry.cliSessionId);
              // Will respawn on next message
            },
          });
        }
      }
      return;
    }

    // For passthrough and plain_text: resolve session and send prompt
    const prompt = parsed.type === 'passthrough' ? parsed.content : parsed.content;

    // Resolve or create session
    let indexEntry = sessionIndexStore.findByThreadTs(threadTs);
    let session: PersistentSession;

    if (!indexEntry) {
      // New session
      const prefs = userPrefStore.get(userId);
      const projects = projectStore.getProjects();
      const activeDir = prefs.activeDirectoryId
        ? projects.find((p) => p.id === prefs.activeDirectoryId)
        : projects[0];
      const projectPath = activeDir?.workingDirectory || process.cwd();
      const sessionId = crypto.randomUUID();

      session = await coordinator.getOrCreateSession({
        sessionId,
        userId,
        model: prefs.defaultModel,
        projectPath,
        budgetUsd: config.defaultBudgetUsd,
        isResume: false,
      });

      // Register in index
      sessionIndexStore.register({
        cliSessionId: sessionId,
        threadTs,
        channelId,
        userId,
        projectPath,
        name: text.substring(0, 50),
        model: prefs.defaultModel,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      });

      // Post thread header (ephemeral)
      const headerText = buildThreadHeaderText({
        projectPath,
        model: prefs.defaultModel,
        sessionId,
      });
      await app.client.chat.postEphemeral({
        channel: channelId,
        thread_ts: threadTs,
        user: userId,
        text: headerText,
      });

      indexEntry = sessionIndexStore.findByThreadTs(threadTs)!;
    } else {
      // Existing session — always use user's current preferred model
      const prefs = userPrefStore.get(userId);
      const preferredModel = prefs.defaultModel;
      const existingSession = coordinator.getSession(indexEntry.cliSessionId);

      if (existingSession && existingSession.state !== 'dead') {
        // If model changed, kill the old session and respawn with new model
        if (existingSession.model !== preferredModel) {
          logger.info(`Model changed from ${existingSession.model} to ${preferredModel}, restarting session ${indexEntry.cliSessionId}`);
          existingSession.kill();
          // Wait for process to die before respawning
          await new Promise<void>((resolve) => {
            if (existingSession.state === 'dead') return resolve();
            existingSession.on('stateChange', (_from: string, to: string) => {
              if (to === 'dead') resolve();
            });
          });
          session = await coordinator.getOrCreateSession({
            sessionId: indexEntry.cliSessionId,
            userId,
            model: preferredModel,
            projectPath: indexEntry.projectPath,
            budgetUsd: config.defaultBudgetUsd,
            isResume: true,
          });
        } else {
          session = existingSession;
        }
      } else {
        // Respawn dead session with current preferred model
        session = await coordinator.getOrCreateSession({
          sessionId: indexEntry.cliSessionId,
          userId,
          model: preferredModel,
          projectPath: indexEntry.projectPath,
          budgetUsd: config.defaultBudgetUsd,
          isResume: true,
        });
      }

      // Update index if model changed
      if (indexEntry.model !== preferredModel) {
        sessionIndexStore.update(indexEntry.cliSessionId, { model: preferredModel });
      }
    }

    // Wire message handler for this session (idempotent — check if already wired)
    wireSessionOutput(session, channelId, threadTs, reactionManager, app.client, sessionIndexStore);

    // For a new/starting session, send the initial prompt BEFORE waiting for idle.
    // Claude CLI stream-json mode requires a user message on stdin before it emits
    // the system init event — without this the bridge deadlocks.
    if (session.state === 'starting') {
      activeMessageTs.set(session.sessionId, messageTs);
      session.sendInitialPrompt(prompt);
      await reactionManager.addSpawning(channelId, messageTs);

      // Replace hourglass with brain when CLI starts processing
      const onStateChange = (_from: string, to: string) => {
        if (to === 'processing') {
          reactionManager.replaceWithProcessing(channelId, messageTs);
          session.removeListener('stateChange', onStateChange);
        }
      };
      session.on('stateChange', onStateChange);

      try {
        await waitForIdle(session);
      } catch (err) {
        session.removeListener('stateChange', onStateChange);
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Failed to start session: ${(err as Error).message}`,
        });
        return;
      }
      // First turn complete — wireSessionOutput already posted the response
      return;
    }

    // Send prompt or queue (existing/idle session)
    if (session.state === 'idle') {
      activeMessageTs.set(session.sessionId, messageTs);
      await reactionManager.replaceWithProcessing(channelId, messageTs);
      session.sendPrompt(prompt);
    } else if (session.state === 'processing') {
      const queue = coordinator.getSessionQueue(indexEntry.cliSessionId);
      if (queue) {
        const enqueued = queue.enqueue({ id: messageTs, prompt });
        if (enqueued) {
          await reactionManager.addQueued(channelId, messageTs);
        } else {
          await app.client.chat.postEphemeral({
            channel: channelId,
            thread_ts: threadTs,
            user: userId,
            text: 'Queue is full. Please wait for current messages to complete.',
          });
        }
      }
    }
  }

  // Track which sessions have output wired
  const wiredSessions = new Set<string>();
  // Track which user message is currently being processed per session
  const activeMessageTs = new Map<string, string>();

  function wireSessionOutput(
    session: PersistentSession,
    channelId: string,
    threadTs: string,
    rm: ReactionManager,
    client: any,
    indexStore: SessionIndexStore,
  ): void {
    if (wiredSessions.has(session.sessionId)) return;
    wiredSessions.add(session.sessionId);

    // --- Streaming: StreamProcessor + Executor ---
    const streamProcessor = new StreamProcessor({ channel: channelId, threadTs });
    const executor = new SlackActionExecutor(client);

    // Wire StreamProcessor actions to Slack executor
    streamProcessor.on('action', async (action: any) => {
      const result = await executor.execute(action);
      if (result.ok && result.ts) {
        if (action.metadata.toolUseId) {
          streamProcessor.registerMessageTs(action.metadata.toolUseId, result.ts);
        }
        if (action.metadata.messageType === 'text' && action.type === 'postMessage') {
          streamProcessor.registerTextMessageTs(result.ts);
        }
      }
    });

    session.on('message', async (event: any) => {
      try {
        // Feed ALL events to StreamProcessor (handles tools, thinking, and text streaming)
        streamProcessor.processEvent(event);

        // Debug: log all events for diagnosis
        if (event.type === 'assistant') {
          const contentTypes = (event.message?.content || []).map((b: any) => b.type).join(',');
          logger.info(`[${session.sessionId}] assistant event: content_types=[${contentTypes}]`);
        }

        // --- Result handling ---
        if (event.type === 'result') {
          logger.info(`[${session.sessionId}] result event received`);

          const usage = event.usage || {};
          const contextTokens = (usage.input_tokens || 0)
            + (usage.cache_read_input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
            + (usage.output_tokens || 0);

          const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
          const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;

          const footerBlocks = buildResponseFooter({
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            contextTokens,
            contextWindow,
            model: indexStore.findByThreadTs(threadTs)?.model || 'unknown',
            durationMs: event.duration_ms || 0,
          });

          // Post result footer as a new message (text was already displayed by StreamProcessor)
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks: footerBlocks,
            text: 'Complete',
          });

          const msgTs = activeMessageTs.get(session.sessionId) || threadTs;
          await rm.replaceWithDone(channelId, msgTs);
          activeMessageTs.delete(session.sessionId);

          indexStore.update(
            indexStore.findByThreadTs(threadTs)?.cliSessionId || '',
            { lastActiveAt: new Date().toISOString() },
          );

          // Reset StreamProcessor for next turn
          streamProcessor.reset();
        }
      } catch (err) {
        logger.error('Error handling session message', { error: (err as Error).message });
      }
    });

    session.on('error', async (err: Error) => {
      logger.error('Session error', { sessionId: session.sessionId, error: err.message });
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Error: ${err.message}`,
        });
      } catch {
        // Ignore Slack API errors during error handling
      }
    });

    // Cleanup on session death
    session.on('stateChange', (_from: string, to: string) => {
      if (to === 'dead' || to === 'ending') {
        streamProcessor.dispose();
      }
    });
  }

  // --- Bolt Event Handlers ---

  app.event('message', async ({ event }) => {
    logger.info('[DEBUG] Bolt message event received', { event_type: (event as any).type, channel_type: (event as any).channel_type });
    await handleMessage(event);
  });

  app.event('app_home_opened', async ({ event }) => {
    await homeTabHandler.publishHomeTab(event.user);
  });

  // Interrupt via reaction
  app.event('reaction_added', async ({ event }) => {
    if ((event as any).reaction !== 'red_circle') return;
    const item = (event as any).item;
    if (!item?.ts) return;
    const entry = sessionIndexStore.findByThreadTs(item.ts);
    if (!entry) return;
    const session = coordinator.getSession(entry.cliSessionId);
    if (session && session.state === 'processing') {
      session.sendControl({ type: 'control', subtype: 'interrupt' });
    }
  });

  // --- Home Tab Actions ---

  app.action('home_set_default_model', async ({ ack, body }: any) => {
    await ack();
    const value = body.actions[0]?.selected_option?.value;
    if (value) {
      await actionHandler.handleSetDefaultModel(body.user.id, value);
    }
  });

  app.action('home_set_directory', async ({ ack, body }: any) => {
    await ack();
    const value = body.actions[0]?.selected_option?.value;
    if (value) {
      await actionHandler.handleSetDirectory(body.user.id, value);
    }
  });

  app.action('open_session', async ({ ack, body }: any) => {
    await ack();
    const sessionId = body.actions[0]?.value;
    if (sessionId) {
      const entry = sessionIndexStore.get(sessionId);
      if (entry) {
        await app.client.chat.postEphemeral({
          channel: entry.channelId,
          user: body.user.id,
          text: `Open the thread at <#${entry.channelId}> to continue session "${entry.name}"`,
        });
      }
    }
  });

  app.action('session_page_prev', async ({ ack, body }: any) => {
    await ack();
    // Parse page from value, publish updated home tab
    const page = Math.max(0, parseInt(body.actions[0]?.value || '0', 10));
    await homeTabHandler.publishHomeTab(body.user.id, page);
  });

  app.action('session_page_next', async ({ ack, body }: any) => {
    await ack();
    const page = parseInt(body.actions[0]?.value || '0', 10);
    await homeTabHandler.publishHomeTab(body.user.id, page);
  });

  // --- Permission Prompt Actions ---

  app.action('permission_approve', async ({ ack, body, action }: any) => {
    await ack();
    const { toolUseId, allowed } = parsePermissionAction(action.value);
    const threadTs = body.message?.thread_ts || body.message?.ts;
    const entry = sessionIndexStore.findByThreadTs(threadTs);
    if (entry) {
      const session = coordinator.getSession(entry.cliSessionId);
      session?.sendControl({ type: 'control', subtype: 'can_use_tool', tool_use_id: toolUseId, allowed });
    }
  });

  app.action('permission_deny', async ({ ack, body, action }: any) => {
    await ack();
    const { toolUseId, allowed } = parsePermissionAction(action.value);
    const threadTs = body.message?.thread_ts || body.message?.ts;
    const entry = sessionIndexStore.findByThreadTs(threadTs);
    if (entry) {
      const session = coordinator.getSession(entry.cliSessionId);
      session?.sendControl({ type: 'control', subtype: 'can_use_tool', tool_use_id: toolUseId, allowed });
    }
  });

  // --- Start ---
  await startApp(app);
  logger.info('Claude Code Slack Bridge is running (Phase 2)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    // End all alive sessions
    for (const entry of sessionIndexStore.getActive()) {
      coordinator.endSession(entry.cliSessionId);
    }
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
