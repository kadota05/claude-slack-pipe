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
import { acquirePidLock } from './utils/pid-lock.js';
import { StreamProcessor } from './streaming/stream-processor.js';
import { SlackActionExecutor } from './streaming/slack-action-executor.js';
import { buildToolModal, buildThinkingModal, buildSubagentModal, buildBundleDetailModal } from './slack/modal-builder.js';
import type { BundleAction } from './streaming/types.js';
import { SerialActionQueue } from './streaming/serial-action-queue.js';
import { SessionJsonlReader } from './streaming/session-jsonl-reader.js';
import { SubagentJsonlReader } from './streaming/subagent-jsonl-reader.js';
import { Heartbeat } from './heartbeat.js';
import { RecentSessionScanner } from './store/recent-session-scanner.js';

function waitForIdle(session: PersistentSession, timeoutMs = 300000): Promise<void> {
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

  // Singleton lock — prevent duplicate instances
  const pidLock = acquirePidLock(config.dataDir);

  const heartbeat = new Heartbeat(config.dataDir);
  heartbeat.start();

  const app = createApp(config);

  // Initialize stores
  const projectStore = new ProjectStore(config.claudeProjectsDir);
  const userPrefStore = new UserPreferenceStore(config.dataDir);
  const sessionIndexStore = new SessionIndexStore(config.dataDir);

  const recentSessionScanner = new RecentSessionScanner(config.claudeProjectsDir);

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
  const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, projectStore, heartbeat, recentSessionScanner);
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

    const executor = new SlackActionExecutor(client);
    const streamProcessor = new StreamProcessor({
      channel: channelId,
      threadTs,
      sessionId: session.sessionId,
    });
    const serialQueue = new SerialActionQueue();

    serialQueue.onError((err) => {
      logger.error('SerialActionQueue error', { error: err.message });
    });

    // Convert BundleAction to SlackAction for the executor
    function convertBundleActionToSlackAction(ba: BundleAction): any {
      const priority = ba.type === 'update' ? 4 : 3;
      return {
        type: ba.type === 'postMessage' ? 'postMessage' : 'update',
        priority,
        channel: channelId,
        threadTs,
        messageTs: (ba as any).messageTs,
        blocks: ba.blocks,
        text: ba.text || '',
        metadata: {
          messageType: 'tool_use',
          bundleId: ba.bundleId,
        },
      };
    }

    session.on('message', (event: any) => {
      serialQueue.enqueue(async () => {
        try {
          // 1. Process event synchronously — returns actions
          const { bundleActions, textAction, resultEvent } = streamProcessor.processEvent(event);

          // 2. Execute bundle actions sequentially
          for (const ba of bundleActions) {
            const slackAction = convertBundleActionToSlackAction(ba);
            const result = await executor.execute(slackAction);
            if (result.ok && result.ts && ba.type === 'postMessage') {
              streamProcessor.registerBundleMessageTs(ba.bundleId, result.ts);
            }
          }

          // 3. Execute text action
          if (textAction) {
            const result = await executor.execute(textAction);
            if (result.ok && result.ts && textAction.type === 'postMessage') {
              streamProcessor.registerTextMessageTs(result.ts);
            }
          }

          // 6. Handle result event
          if (resultEvent) {
            logger.info(`[${session.sessionId}] result event received`);

            const usage = resultEvent.usage || {};
            const inputTotal = (usage.input_tokens || 0)
              + (usage.cache_read_input_tokens || 0)
              + (usage.cache_creation_input_tokens || 0);

            const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
            const modelUsageEntry = resultEvent.modelUsage
              && Object.values(resultEvent.modelUsage)[0];
            const contextWindow = modelUsageEntry?.contextWindow
              || (sessionModel.includes('haiku') ? 200_000 : 1_000_000);

            const footerBlocks = buildResponseFooter({
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              contextUsed: inputTotal,
              contextWindow,
              model: indexStore.findByThreadTs(threadTs)?.model || 'unknown',
              durationMs: resultEvent.duration_ms || 0,
            });

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

            streamProcessor.reset();
          }
        } catch (err) {
          logger.error('Error handling session message', { error: (err as Error).message });
        }
      });
    });

    session.on('error', async (err: Error) => {
      logger.error('Session error', { sessionId: session.sessionId, error: err.message });
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Error: ${err.message}`,
        });
      } catch { /* ignore */ }
    });

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

  // Interrupt via reaction — only targets messages currently being processed
  app.event('reaction_added', async ({ event }) => {
    if ((event as any).reaction !== 'red_circle') return;
    const item = (event as any).item;
    if (!item?.ts) return;
    // Find session by matching activeMessageTs values
    for (const [sessionId, msgTs] of activeMessageTs) {
      if (msgTs === item.ts) {
        const session = coordinator.getSession(sessionId);
        if (session && session.state === 'processing') {
          session.sendControl({ type: 'control', subtype: 'interrupt' });
        }
        break;
      }
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

  // --- Tool Detail Modal Action ---
  const sessionJsonlReader = new SessionJsonlReader(config.claudeProjectsDir);

  app.action(/^view_tool_detail:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const parts = actionId.split(':');
    let sessionId: string | undefined;
    let toolUseId: string;
    if (parts.length >= 3) {
      sessionId = parts[1];
      toolUseId = parts[2];
    } else {
      toolUseId = parts[1];
    }
    if (!toolUseId) return;

    const isFromModal = !!body.view;

    let entry: any = null;
    if (sessionId) {
      entry = sessionIndexStore.findBySessionId(sessionId);
    }
    if (!entry) {
      const threadTs = body.message?.thread_ts || body.message?.ts
        || body.view?.private_metadata || '';
      entry = threadTs ? sessionIndexStore.findByThreadTs(threadTs) : null;
    }

    let modal: any = null;
    if (entry) {
      const detail = await sessionJsonlReader.readToolDetail(
        entry.projectPath,
        entry.cliSessionId,
        toolUseId,
      );
      if (detail) {
        modal = buildToolModal({
          toolId: detail.toolUseId,
          toolName: detail.toolName,
          input: detail.input,
          result: detail.result,
          durationMs: 0,
          isError: detail.isError,
        });
      }
    }

    if (!modal) {
      logger.warn(`No data found for tool ${toolUseId}`);
      return;
    }

    if (isFromModal) {
      await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
    } else {
      await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
    }
  });

  // --- Bundle Detail Modal Action ---
  const subagentReader = new SubagentJsonlReader(config.claudeProjectsDir);

  app.action(/^view_bundle:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const parts = actionId.split(':');
    const sessionId = parts[1];
    const bundleIndex = parseInt(parts[2], 10);
    if (!sessionId || isNaN(bundleIndex)) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) {
      logger.warn(`No session found for ${sessionId}`);
      return;
    }

    const entries = await sessionJsonlReader.readBundle(
      entry.projectPath,
      sessionId,
      bundleIndex,
    );

    if (entries.length === 0) {
      logger.warn(`No bundle entries for ${sessionId}:${bundleIndex}`);
      return;
    }

    const modal = buildBundleDetailModal(entries, sessionId, bundleIndex);
    const threadTs = body.message?.thread_ts || body.message?.ts || '';
    modal.private_metadata = threadTs;

    await app.client.views.open({
      trigger_id: body.trigger_id,
      view: modal,
    });
  });

  // --- Thinking Detail Modal Action ---
  app.action(/^view_thinking_detail:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const parts = actionId.split(':');
    const sessionId = parts[1];
    const bundleIndex = parseInt(parts[2], 10);
    const thinkingIndex = parseInt(parts[3], 10);
    if (!sessionId || isNaN(bundleIndex) || isNaN(thinkingIndex)) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) return;

    const bundleEntries = await sessionJsonlReader.readBundle(
      entry.projectPath,
      sessionId,
      bundleIndex,
    );

    // Filter thinking entries and pick by index
    const thinkingEntries = bundleEntries.filter(e => e.type === 'thinking');
    const target = thinkingEntries[thinkingIndex];
    if (!target || target.type !== 'thinking') return;

    const modal = buildThinkingModal(target.texts);
    const threadTs = body.view?.private_metadata || '';
    modal.private_metadata = threadTs;

    await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
  });

  // --- SubAgent Detail Modal Action ---
  app.action(/^view_subagent_detail:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const parts = actionId.split(':');
    const sessionId = parts[1];
    const toolUseId = parts[2];
    if (!sessionId || !toolUseId) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) return;

    const agentResult = await sessionJsonlReader.readToolDetail(
      entry.projectPath,
      entry.cliSessionId,
      toolUseId,
    );

    let agentId: string | null = null;
    if (agentResult) {
      const match = agentResult.result.match(/agentId:\s*([\w]+)/);
      if (match) agentId = match[1];
    }

    let flow = null;
    if (agentId) {
      flow = await subagentReader.read(entry.projectPath, entry.cliSessionId, agentId);
    }

    const description = agentResult?.input?.description as string || 'SubAgent';
    const modal = buildSubagentModal(description, flow);
    const threadTs = body.message?.thread_ts || body.message?.ts
      || body.view?.private_metadata || '';
    modal.private_metadata = threadTs;

    const isFromModal = !!body.view;
    if (isFromModal) {
      await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
    } else {
      await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
    }
  });

  // --- Start ---
  await startApp(app);
  logger.info('Claude Code Slack Bridge is running (Phase 2)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    heartbeat.stop();
    // End all alive sessions
    for (const entry of sessionIndexStore.getActive()) {
      coordinator.endSession(entry.cliSessionId);
    }
    pidLock.release();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: err?.message || err });
  process.exit(1);
});
