import { createApp, startApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AuthMiddleware } from './middleware/auth.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { ProjectStore, decodeProjectId } from './store/project-store.js';
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
import { sanitizeUserInput, sanitizeOutput } from './utils/sanitizer.js';
import { buildResponseFooter, buildThreadHeaderText, buildStreamingBlocks } from './slack/block-builder.js';
import fs from 'node:fs';
import type { PersistentSession } from './bridge/persistent-session.js';

function waitForIdle(session: PersistentSession, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (session.state === 'idle') { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('Session init timeout')), timeoutMs);
    session.on('stateChange', (_from: string, to: string) => {
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
    if (event.channel_type !== 'im') return;
    if (event.bot_id || event.subtype) return;

    const userId = event.user;
    const channelId = event.channel;
    const messageTs = event.ts;
    const threadTs = event.thread_ts || event.ts;
    const text = sanitizeUserInput(event.text || '');

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
      const projectPath = activeDir ? decodeProjectId(activeDir.id) : process.cwd();
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
      // Existing session
      const existingSession = coordinator.getSession(indexEntry.cliSessionId);
      if (existingSession && existingSession.state !== 'dead') {
        session = existingSession;
      } else {
        // Respawn dead session
        session = await coordinator.getOrCreateSession({
          sessionId: indexEntry.cliSessionId,
          userId,
          model: indexEntry.model,
          projectPath: indexEntry.projectPath,
          budgetUsd: config.defaultBudgetUsd,
          isResume: true,
        });
      }
    }

    // Wire message handler for this session (idempotent — check if already wired)
    wireSessionOutput(session, channelId, threadTs, reactionManager, app.client, sessionIndexStore);

    // Wait for session to be ready
    if (session.state === 'starting') {
      try {
        await waitForIdle(session);
      } catch (err) {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Failed to start session: ${(err as Error).message}`,
        });
        return;
      }
    }

    // Send prompt or queue
    if (session.state === 'idle') {
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
    } else if (session.state === 'starting') {
      // Queue for after init
      const queue = coordinator.getSessionQueue(indexEntry.cliSessionId);
      if (queue) {
        queue.enqueue({ id: messageTs, prompt });
        await reactionManager.addSpawning(channelId, messageTs);
      }
    }
  }

  // Track which sessions have output wired
  const wiredSessions = new Set<string>();

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

    let responseBuffer = '';
    let streamingMessageTs: string | null = null;
    let lastUpdateTime = 0;

    session.on('message', async (event: any) => {
      try {
        if (event.type === 'assistant') {
          // Handle content_block_delta for streaming text
          if (event.subtype === 'content_block_delta' && event.delta?.type === 'text_delta') {
            responseBuffer += event.delta.text;
          }
          // Handle full message (content_block_stop or final)
          else if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                responseBuffer += block.text;
              }
            }
          }

          // Throttled streaming update (every 1.5s)
          const now = Date.now();
          if (now - lastUpdateTime > 1500 && responseBuffer) {
            lastUpdateTime = now;
            const blocks = buildStreamingBlocks({ text: responseBuffer, isComplete: false });
            if (!streamingMessageTs) {
              const resp = await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                blocks,
                text: responseBuffer.slice(0, 100),
              });
              streamingMessageTs = resp.ts;
            } else {
              await client.chat.update({
                channel: channelId,
                ts: streamingMessageTs,
                blocks,
                text: responseBuffer.slice(0, 100),
              });
            }
          }
        }

        if (event.type === 'result') {
          // Final response
          const resultText = sanitizeOutput(event.result || responseBuffer || '(no response)');
          const footerBlocks = buildResponseFooter({
            inputTokens: event.usage?.input_tokens || 0,
            outputTokens: event.usage?.output_tokens || 0,
            costUsd: event.total_cost_usd || 0,
            model: indexStore.findByThreadTs(threadTs)?.model || 'unknown',
            durationMs: event.duration_ms || 0,
          });

          if (streamingMessageTs) {
            // Update streaming message with final text
            await client.chat.update({
              channel: channelId,
              ts: streamingMessageTs,
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: resultText.slice(0, 3000) } },
                ...footerBlocks,
              ],
              text: resultText.slice(0, 100),
            });
          } else {
            // No streaming was shown — post final message
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: resultText.slice(0, 3000) } },
                ...footerBlocks,
              ],
              text: resultText.slice(0, 100),
            });
          }

          // Update reactions
          await rm.replaceWithDone(channelId, threadTs);

          // Update session index
          indexStore.update(
            indexStore.findByThreadTs(threadTs)?.cliSessionId || '',
            { lastActiveAt: new Date().toISOString() },
          );

          // Reset buffer for next turn
          responseBuffer = '';
          streamingMessageTs = null;
          lastUpdateTime = 0;
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
  }

  // --- Bolt Event Handlers ---

  app.event('message', async ({ event }) => {
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
