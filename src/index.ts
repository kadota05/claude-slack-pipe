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
import { processFiles, type SlackFile } from './slack/file-processor.js';
import { parsePermissionAction } from './slack/permission-prompt.js';
import { sanitizeUserInput } from './utils/sanitizer.js';
import { buildResponseFooter, buildThreadHeaderText } from './slack/block-builder.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PersistentSession } from './bridge/persistent-session.js';
import { StreamProcessor } from './streaming/stream-processor.js';
import { SlackActionExecutor } from './streaming/slack-action-executor.js';
import { buildToolModal, buildThinkingModal, buildSubagentModal, buildBundleDetailModal, buildFileContentModal, buildFileChunksModal, buildFileChunkModal } from './slack/modal-builder.js';
import type { BundleAction } from './streaming/types.js';
import { SerialActionQueue } from './streaming/serial-action-queue.js';
import { SessionJsonlReader } from './streaming/session-jsonl-reader.js';
import { SubagentJsonlReader } from './streaming/subagent-jsonl-reader.js';
import { ChannelProjectManager } from './bridge/channel-project-manager.js';
import { ChannelScheduler } from './bridge/channel-scheduler.js';
import { notifyText } from './streaming/notification-text.js';
import { RecentSessionScanner } from './store/recent-session-scanner.js';
import { TunnelManager } from './streaming/tunnel-manager.js';
import { NetworkWatcher } from './utils/network-watcher.js';
import { AutoUpdater } from './auto-updater.js';
import { SocketWatchdog } from './utils/socket-watchdog.js';
import { buildBridgeContext, migrateTemplates } from './bridge/bridge-context.js';

/**
 * Wait for CLI to initialize (starting → processing or idle).
 * Does NOT wait for the first turn to complete — that is handled by wireSessionOutput.
 */
function waitForInit(session: PersistentSession, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (session.state !== 'starting') { resolve(); return; }
    logger.info(`[waitForInit] waiting for session ${session.sessionId} to initialize`);
    const timer = setTimeout(() => {
      logger.error(`[waitForInit] timeout after ${timeoutMs}ms, state: ${session.state}`);
      reject(new Error('Session init timeout'));
    }, timeoutMs);
    const onStateChange = (_from: string, to: string) => {
      logger.info(`[waitForInit] stateChange: ${_from} → ${to}`);
      if (to === 'processing' || to === 'idle') {
        clearTimeout(timer);
        session.removeListener('stateChange', onStateChange);
        resolve();
      }
      if (to === 'dead') {
        clearTimeout(timer);
        session.removeListener('stateChange', onStateChange);
        if (session.wasInterrupted) {
          resolve();
        } else {
          reject(new Error('Session died during init'));
        }
      }
    };
    session.on('stateChange', onStateChange);
  });
}

async function slackViewsOpen(token: string | undefined, triggerId: string, view: any): Promise<any> {
  const resp = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  return resp.json();
}

async function slackViewsPush(token: string | undefined, triggerId: string, view: any): Promise<any> {
  const resp = await fetch('https://slack.com/api/views.push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  return resp.json();
}

async function main(): Promise<void> {
  // Circuit breaker — prevent crash loops under launchd
  if (process.env.MANAGED_BY_LAUNCHD) {
    const crashFile = path.join(
      os.homedir(),
      '.claude-slack-pipe',
      'crash-history.json',
    );
    const now = Date.now();
    let history: number[] = [];
    try {
      history = JSON.parse(fs.readFileSync(crashFile, 'utf-8'));
    } catch { /* first run or corrupt */ }
    // Keep only entries within 60s window, cap at 4
    history = history.filter((t) => now - t < 60_000).slice(-4);
    if (history.length >= 4) {
      logger.error('Crash loop detected (5 crashes in 60s). Sleeping 5 minutes before retry. Fix the issue and restart with: launchctl kickstart -k gui/$(id -u)/com.user.claude-slack-pipe');
      await new Promise((resolve) => setTimeout(resolve, 300_000));
      // Clear history after sleep so we get a fresh start
      fs.writeFileSync(crashFile, '[]');
    }
    history.push(now);
    fs.mkdirSync(path.dirname(crashFile), { recursive: true });
    fs.writeFileSync(crashFile, JSON.stringify(history));
  }

  const config = loadConfig();

  // Record startup time for gap message filtering
  // Messages sent before this time (during process downtime) will be ignored.
  const startedAt = Date.now() / 1000; // Slack ts format (seconds since epoch)

  // Simple log rotation for launchd stdout/stderr files
  if (process.env.MANAGED_BY_LAUNCHD) {
    const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
    for (const logFile of ['bridge.stdout.log', 'bridge.stderr.log']) {
      const logPath = path.join(config.dataDir, logFile);
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > MAX_LOG_SIZE) {
          fs.renameSync(logPath, logPath + '.old');
          logger.info(`Rotated ${logFile} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch { /* file doesn't exist yet */ }
    }
  }

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // Migrate templates and build bridge context
  const templatesDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');
  await migrateTemplates(config.dataDir, templatesDir);
  const bridgeContext = await buildBridgeContext(config.dataDir);
  if (bridgeContext) {
    logger.info(`Bridge context loaded (${bridgeContext.length} chars)`);
  }

  // Initialize Channel Project Manager
  const channelTemplatesDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'channel-project');
  const channelProjectManager = new ChannelProjectManager(config.dataDir, channelTemplatesDir);

  // Migrate existing channel routes from slack-memory.json
  const slackMemoryPath = path.join(config.dataDir, 'slack-memory.json');
  try {
    if (fs.existsSync(slackMemoryPath)) {
      const routes = JSON.parse(fs.readFileSync(slackMemoryPath, 'utf-8'));
      for (const route of routes) {
        if (route.channelId && !channelProjectManager.exists(route.channelId)) {
          await channelProjectManager.init(route.channelId);
          logger.info(`Migrated channel route: ${route.channelId} (${route.description})`);
        }
      }
      fs.renameSync(slackMemoryPath, slackMemoryPath + '.migrated');
      logger.info('slack-memory.json migrated and renamed to .migrated');
    }
  } catch (err) {
    logger.warn('Failed to migrate slack-memory.json:', err);
  }

  const app = createApp(config);

  // Initialize stores
  const projectStore = new ProjectStore(config.claudeProjectsDir);
  const userPrefStore = new UserPreferenceStore(config.dataDir);
  const sessionIndexStore = new SessionIndexStore(config.dataDir);

  const recentSessionScanner = new RecentSessionScanner(config.claudeProjectsDir);

  const tunnelManager = new TunnelManager();

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
  const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, projectStore, recentSessionScanner);
  const actionHandler = new ActionHandler(userPrefStore, coordinator, homeTabHandler);

  // --- Duplicate message guard ---
  // Tracks recent top-level messages per user to block duplicate Slack events
  // (e.g. client re-sends with new ts while directory is changed).
  // Only applies to new threads (no thread_ts), not thread replies.
  const recentNewThreadMessages = new Map<string, { ts: string; time: number }>();
  const DEDUP_WINDOW_MS = 30_000;

  // --- Per-user session creation lock ---
  // Prevents race condition between findByThreadTs and register
  // when concurrent handleMessage calls overlap during await.
  const sessionCreationLocks = new Map<string, Promise<void>>();

  // --- Message Handler ---
  async function handleMessage(event: any): Promise<void> {
    if (isShuttingDown) return;
    socketWatchdog.recordMessageEvent();
    logger.info('[DEBUG] handleMessage called', { type: event.type, channel_type: event.channel_type, bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 50), user: event.user, ts: event.ts, client_msg_id: event.client_msg_id });
    const isChannel = event.channel_type !== 'im';

    if (isChannel) {
      if (!channelProjectManager.exists(event.channel)) return;
      if (event.bot_id || event.subtype === 'bot_message') return;
    }

    if (!isChannel) {
      if (event.bot_id) { logger.info('[DEBUG] skipped: bot_id', { bot_id: event.bot_id }); return; }
      if (event.subtype && event.subtype !== 'file_share') { logger.info('[DEBUG] skipped: subtype', { subtype: event.subtype }); return; }
    }

    // Drop messages sent before this process started (e.g. during WiFi outage, crash)
    if (parseFloat(event.ts) < startedAt) {
      logger.info('[Resilience] Dropping message from before process start', {
        ts: event.ts, startedAt,
      });
      return;
    }

    const userId = event.user;
    const channelId = event.channel;
    const messageTs = event.ts;
    const threadTs = event.thread_ts || event.ts;
    const text = sanitizeUserInput(event.text || '');

    // Process file attachments if present
    let fileContentBlocks: import('./types.js').StdinContentBlock[] | null = null;
    if (event.files && Array.isArray(event.files) && event.files.length > 0) {
      const botToken = process.env.SLACK_BOT_TOKEN!;
      const result = await processFiles(event.files as SlackFile[], botToken);

      // Post warnings for unsupported/failed files
      if (result.warnings.length > 0) {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `⚠️ ${result.warnings.join('\n⚠️ ')}`,
        });
      }

      if (result.contentBlocks.length === 0 && !text) {
        // All files unsupported and no text — nothing to process
        return;
      }

      if (result.contentBlocks.length > 0) {
        // Build combined content blocks: files + optional text
        fileContentBlocks = [...result.contentBlocks];
        if (text) {
          fileContentBlocks.push({ type: 'text', text });
        }
      }
    }

    // --- Guard: block duplicate new-thread messages ---
    // Only for top-level messages (potential new threads), not thread replies.
    if (!event.thread_ts) {
      const fileIds = event.files?.map((f: any) => f.id).join(',') || '';
      const dedupKey = `${userId}:${text}:${fileIds}`;
      const now = Date.now();
      const prev = recentNewThreadMessages.get(dedupKey);
      if (prev && (now - prev.time) < DEDUP_WINDOW_MS) {
        logger.warn('[DEDUP] Blocked duplicate new-thread message', {
          userId,
          textPreview: text.slice(0, 50),
          prevTs: prev.ts,
          newTs: messageTs,
          sameTsAsOriginal: prev.ts === messageTs,
          elapsedMs: now - prev.time,
        });
        return;
      }
      recentNewThreadMessages.set(dedupKey, { ts: messageTs, time: now });
      // Clean old entries
      for (const [k, v] of recentNewThreadMessages) {
        if (now - v.time > 60_000) recentNewThreadMessages.delete(k);
      }
    }

    // Block messages during auto-update
    if (autoUpdater?.isPendingUpdate()) {
      const blockMsg = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: '🔄 システムを最新バージョンに更新中です。まもなく再起動します。',
      });
      if (blockMsg.ts) {
        autoUpdater.addBlockedMessage(channelId, blockMsg.ts);
      }
      return;
    }

    logger.info('[DEBUG] auth check', { userId, allowed: auth.isAllowed(userId) });
    // Auth + Rate limit
    if (!auth.isAllowed(userId)) {
      if (isChannel) {
        await app.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '⛔ このbotを使う権限がありません。',
        });
      }
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

    // Parse command (channels skip command parsing)
    const parsed = isChannel
      ? { type: 'plain_text' as const, content: text }
      : parseCommand(text);

    // Bot commands
    if (parsed.type === 'bot_command') {
      // restart-bridge is a global command — no session context needed
      if (parsed.command === 'restart-bridge') {
        if (!auth.isAdmin(userId)) {
          await app.client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: '⛔ This command requires admin privileges.',
          });
          return;
        }
        const restartMsg = await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: '🔄 Bridgeを再起動します...',
        });
        // Save restart message info so new process can update it
        const restartPendingFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
        try {
          fs.writeFileSync(restartPendingFile, JSON.stringify({
            channel: channelId,
            ts: restartMsg.ts,
            thread_ts: threadTs,
          }));
        } catch { /* best-effort */ }
        await shutdown('restart-bridge');
        return;
      }

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
    const prompt: string | import('./types.js').StdinContentBlock[] = fileContentBlocks || (parsed.type === 'passthrough' ? parsed.content : parsed.content);

    // Resolve or create session
    // Acquire per-thread lock to prevent race condition between findByThreadTs and register
    const lockKey = threadTs;
    const prevLock = sessionCreationLocks.get(lockKey) || Promise.resolve();
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    sessionCreationLocks.set(lockKey, prevLock.then(() => lockPromise));
    await prevLock;

    let indexEntry: ReturnType<typeof sessionIndexStore.findByThreadTs>;
    let session: PersistentSession;

    try {
      indexEntry = sessionIndexStore.findByThreadTs(threadTs);

      if (!indexEntry) {
        let projectPath: string;
        let sessionModel: string;
        let sessionContext: string | undefined;

        if (isChannel) {
          projectPath = channelProjectManager.getProjectPath(event.channel);
          try {
            const settings = JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'));
            sessionModel = settings.model || 'sonnet';
          } catch {
            sessionModel = 'sonnet';
          }
          sessionContext = await channelProjectManager.buildContext(event.channel);
        } else {
          const prefs = userPrefStore.get(userId);
          const projects = projectStore.getProjects();
          const activeDir = prefs.activeDirectoryId
            ? projects.find((p) => p.id === prefs.activeDirectoryId)
            : projects[0];
          projectPath = activeDir?.workingDirectory || process.cwd();
          sessionModel = prefs.defaultModel;
          sessionContext = bridgeContext;
        }

        const sessionId = crypto.randomUUID();
        session = await coordinator.getOrCreateSession({
          sessionId,
          userId: isChannel ? channelId : userId,
          model: sessionModel,
          projectPath,
          isResume: false,
          bridgeContext: sessionContext,
          maxAliveOverride: isChannel ? 3 : undefined,
        });

        sessionIndexStore.register({
          cliSessionId: sessionId,
          threadTs,
          channelId,
          userId: isChannel ? channelId : userId,
          projectPath,
          name: text.substring(0, 50),
          model: sessionModel,
          status: 'active',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        });

        if (!isChannel) {
          const headerText = buildThreadHeaderText({ projectPath, model: sessionModel, sessionId });
          await app.client.chat.postEphemeral({ channel: channelId, thread_ts: threadTs, user: userId, text: headerText });
        }

        indexEntry = sessionIndexStore.findByThreadTs(threadTs)!;
      } else {
        const existingSession = coordinator.getSession(indexEntry.cliSessionId);

        if (isChannel) {
          if (existingSession && existingSession.state !== 'dead') {
            session = existingSession;
          } else {
            const channelContext = await channelProjectManager.buildContext(event.channel);
            session = await coordinator.getOrCreateSession({
              sessionId: indexEntry.cliSessionId,
              userId: channelId,
              model: indexEntry.model,
              projectPath: indexEntry.projectPath,
              isResume: true,
              bridgeContext: channelContext,
              maxAliveOverride: 3,
            });
          }
        } else {
          // Existing DM session — model switch logic
          const prefs = userPrefStore.get(userId);
          const preferredModel = prefs.defaultModel;

          if (existingSession && existingSession.state !== 'dead') {
            if (existingSession.model !== preferredModel) {
              logger.info(`Model changed from ${existingSession.model} to ${preferredModel}, restarting session ${indexEntry.cliSessionId}`);
              existingSession.kill('model_change');
              await app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `:arrows_counterclockwise: モデルを ${existingSession.model} → ${preferredModel} に変更しました。セッションを再起動します。`,
              });
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
                isResume: true,
                bridgeContext,
              });
            } else {
              session = existingSession;
            }
          } else {
            session = await coordinator.getOrCreateSession({
              sessionId: indexEntry.cliSessionId,
              userId,
              model: preferredModel,
              projectPath: indexEntry.projectPath,
              isResume: true,
              bridgeContext,
            });
          }

          if (indexEntry.model !== preferredModel) {
            sessionIndexStore.update(indexEntry.cliSessionId, { model: preferredModel });
          }
        }
      }
    } finally {
      releaseLock!();
    }

    // Wire message handler for this session (idempotent — check if already wired)
    wireSessionOutput(session, channelId, threadTs, reactionManager, app.client, sessionIndexStore, indexEntry.projectPath);

    // For a new/starting session, send the initial prompt BEFORE waiting for init.
    // Claude CLI stream-json mode requires a user message on stdin before it emits
    // the system init event — without this the bridge deadlocks.
    if (session.state === 'starting') {
      activeMessageTs.set(session.sessionId, messageTs);
      session.sendInitialPrompt(prompt);
      await reactionManager.addSpawning(channelId, messageTs);

      try {
        await waitForInit(session);
      } catch (err) {
        session.end();
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
      await reactionManager.addSpawning(channelId, messageTs);
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

  // When coordinator auto-dequeues a queued message, register its ts
  // so that 🔴 reaction interrupt can find the matching session.
  coordinator.onDequeueCallback = (sessionId, messageId) => {
    activeMessageTs.set(sessionId, messageId);
  };

  function wireSessionOutput(
    session: PersistentSession,
    channelId: string,
    threadTs: string,
    rm: ReactionManager,
    client: any,
    indexStore: SessionIndexStore,
    projectPath: string,
  ): void {
    if (wiredSessions.has(session.sessionId)) return;
    wiredSessions.add(session.sessionId);

    const executor = new SlackActionExecutor(client);
    const streamProcessor = new StreamProcessor({
      channel: channelId,
      threadTs,
      sessionId: session.sessionId,
      cwd: projectPath,
      tunnelManager,
      onFirstContent: () => {
        const msgTs = activeMessageTs.get(session.sessionId);
        if (msgTs) {
          void rm.replaceWithProcessing(session.sessionId, channelId, msgTs);
        }
      },
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
      // Capture the active message ts NOW (synchronously), before the
      // coordinator's stateChange handler can overwrite it via auto-dequeue.
      // The result event triggers transition('idle') synchronously after
      // emit('message'), so by the time the serialQueue handler runs,
      // activeMessageTs may already point to the next queued message.
      const capturedMsgTs = activeMessageTs.get(session.sessionId);

      serialQueue.enqueue(async () => {
        try {
          // 1. Process event — returns actions (async for tunnel URL rewriting)
          const { bundleActions, textAction, resultEvent, lastMainUsage } = await streamProcessor.processEvent(event);

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
            const isApproximate = !lastMainUsage;
            const effectiveUsage = lastMainUsage || usage;
            const contextUsed = (effectiveUsage.input_tokens || 0)
              + (effectiveUsage.cache_read_input_tokens || 0)
              + (effectiveUsage.cache_creation_input_tokens || 0);

            const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
            const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;

            logger.info(`[${session.sessionId}] ctx: ${contextUsed} / ${contextWindow} (${(contextUsed / contextWindow * 100).toFixed(1)}%)${isApproximate ? ' [approx]' : ''}`);

            const footerBlocks = buildResponseFooter({
              contextUsed,
              contextWindow,
              model: sessionModel || 'unknown',
              durationMs: resultEvent.duration_ms || 0,
              isApproximate,
            });

            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: footerBlocks,
              text: notifyText.footer(
                sessionModel || 'unknown',
                resultEvent.duration_ms || 0,
              ),
            });

            // Use the ts captured at emit time — activeMessageTs may already
            // point to the next queued message due to synchronous dequeue.
            const msgTs = capturedMsgTs || threadTs;
            await rm.replaceWithDone(session.sessionId, channelId, msgTs);

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
        wiredSessions.delete(session.sessionId);
        rm.cleanupSession(session.sessionId);
      }
    });
  }

  // --- Bolt Event Handlers ---

  app.event('message', async ({ event }) => {
    logger.info('[DEBUG] Bolt message event received', { event_type: (event as any).type, channel_type: (event as any).channel_type });
    await handleMessage(event);
  });

  app.event('member_joined_channel', async ({ event }: any) => {
    if (event.user !== botUserId) return;
    const channelId = event.channel;

    if (channelProjectManager.exists(channelId)) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: '👋 既存のプロジェクトを復帰しました。続きから始めましょう。',
      });
      logger.info(`Channel project reactivated: ${channelId}`);
      return;
    }

    try {
      await channelProjectManager.init(channelId);
      await app.client.chat.postMessage({
        channel: channelId,
        text: '✅ AIアプリとして初期化しました。何を作りましょう？',
      });
      logger.info(`Channel project initialized: ${channelId}`);
    } catch (err) {
      logger.error(`Failed to init channel project: ${channelId}`, err);
      await app.client.chat.postMessage({
        channel: channelId,
        text: '❌ プロジェクトの初期化に失敗しました。',
      });
    }
  });

  app.event('member_left_channel', async ({ event }: any) => {
    if (event.user !== botUserId) return;
    const channelId = event.channel;
    logger.info(`Bot left channel ${channelId}, deactivating`);

    const activeEntries = sessionIndexStore.findActiveByChannelId(channelId);
    for (const entry of activeEntries) {
      coordinator.endSession(entry.cliSessionId);
      sessionIndexStore.update(entry.cliSessionId, { status: 'ended' });
    }

    channelScheduler.stopChannel(channelId);
  });

  // Track pending restart-complete for home tab
  let restartCompletePendingUser: string | null = null;

  app.event('app_home_opened', async ({ event }) => {
    if (restartCompletePendingUser === event.user) {
      restartCompletePendingUser = null;
      await homeTabHandler.publishHomeTab(event.user, 'completed');
    } else {
      await homeTabHandler.publishHomeTab(event.user);
    }
  });

  // Interrupt via reaction — only targets messages currently being processed
  app.event('reaction_added', async ({ event }) => {
    logger.info('[REACTION] reaction_added event received', {
      reaction: (event as any).reaction,
      itemTs: (event as any).item?.ts,
      itemChannel: (event as any).item?.channel,
    });
    if ((event as any).reaction !== 'red_circle') return;
    const item = (event as any).item;
    if (!item?.ts) return;

    logger.info('[REACTION] 🔴 detected, searching activeMessageTs', {
      itemTs: item.ts,
      activeEntries: Array.from(activeMessageTs.entries()).map(([sid, ts]) => ({ sid: sid.slice(0, 8), ts })),
    });

    // Find session by matching activeMessageTs values
    let found = false;
    for (const [sessionId, msgTs] of activeMessageTs) {
      if (msgTs === item.ts) {
        found = true;
        const session = coordinator.getSession(sessionId);
        logger.info('[REACTION] Match found', {
          sessionId: sessionId.slice(0, 8),
          sessionExists: !!session,
          sessionState: session?.state || 'N/A',
        });
        if (session && session.state === 'processing') {
          session.sendInterrupt();
          logger.info('[REACTION] SIGINT sent to session', { sessionId: sessionId.slice(0, 8) });

          // Clean up UI: remove 🧠, add 🛑, post interruption notice
          const channel = item.channel;
          activeMessageTs.delete(sessionId);
          await reactionManager.removeProcessing(channel, msgTs);

          const indexEntry = sessionIndexStore.findBySessionId(sessionId);
          if (indexEntry) {
            await app.client.chat.postMessage({
              channel,
              thread_ts: indexEntry.threadTs,
              text: '⏹️ Interrupted by user.',
            });
          }
        }
        break;
      }
    }
    if (!found) {
      logger.warn('[REACTION] No matching session found for item.ts', { itemTs: item.ts });
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

  app.action('toggle_star_directory', async ({ ack, body }: any) => {
    await ack();
    const userId = body.user.id;
    // Use activeDirectoryId from store, not the button value.
    // The button value may be stale if Slack mobile hasn't re-rendered
    // the view yet after a directory change.
    const prefs = userPrefStore.get(userId);
    const directoryId = prefs.activeDirectoryId;
    logger.info('[toggle_star] received', { userId, directoryId, buttonValue: body.actions?.[0]?.value });
    if (directoryId) {
      try {
        await actionHandler.handleToggleStar(userId, directoryId);
        logger.info('[toggle_star] completed successfully', { userId, directoryId });
      } catch (err) {
        logger.error('[toggle_star] failed', { error: (err as Error).message, stack: (err as Error).stack });
      }
    } else {
      logger.warn('[toggle_star] no activeDirectoryId in user prefs');
    }
  });

  app.action('home_restart_bridge', async ({ ack, body }: any) => {
    await ack();
    const userId = body.user.id;

    // Guard: if restart already pending, ignore
    const restartPendingFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
    if (fs.existsSync(restartPendingFile)) return;

    // Update home tab to show restarting status
    await homeTabHandler.publishHomeTab(userId, 'restarting');

    // Save pending info for post-restart recovery
    try {
      fs.writeFileSync(restartPendingFile, JSON.stringify({ homeTabUserId: userId }));
    } catch { /* best-effort */ }

    await shutdown('restart-bridge');
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
    const bundleKeyOrIndex = parts.slice(2).join(':');
    if (!sessionId || !bundleKeyOrIndex) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) {
      logger.warn(`No session found for ${sessionId}`);
      return;
    }

    // Legacy format: pure numeric = bundleIndex
    const isLegacyIndex = /^\d+$/.test(bundleKeyOrIndex);
    const entries = isLegacyIndex
      ? await sessionJsonlReader.readBundle(entry.projectPath, sessionId, parseInt(bundleKeyOrIndex, 10))
      : await sessionJsonlReader.readBundleByKey(entry.projectPath, sessionId, bundleKeyOrIndex);

    if (entries.length === 0) {
      logger.warn(`No bundle entries for ${sessionId}:${bundleKeyOrIndex}`);
      return;
    }

    const modal = buildBundleDetailModal(entries, sessionId, bundleKeyOrIndex);
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
    // thinkingIndex is always the LAST part
    const thinkingIndex = parseInt(parts[parts.length - 1], 10);
    // bundleKeyOrIndex is everything between sessionId and thinkingIndex
    const bundleKeyOrIndex = parts.slice(2, -1).join(':');
    if (!sessionId || !bundleKeyOrIndex || isNaN(thinkingIndex)) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) return;

    const isLegacyIndex = /^\d+$/.test(bundleKeyOrIndex);
    const bundleEntries = isLegacyIndex
      ? await sessionJsonlReader.readBundle(entry.projectPath, sessionId, parseInt(bundleKeyOrIndex, 10))
      : await sessionJsonlReader.readBundleByKey(entry.projectPath, sessionId, bundleKeyOrIndex);

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

  // --- File Content Modal Action ---
  app.action(/^view_file_content/, async ({ ack, body }: any) => {
    await ack();
    const filePath = body.actions?.[0]?.value;
    if (!filePath) return;

    const threadTs = body.message?.thread_ts || body.message?.ts || '';
    const entry = threadTs ? sessionIndexStore.findByThreadTs(threadTs) : null;
    const cwd = entry?.projectPath || process.cwd();

    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd) + path.sep;
    logger.info(`[file-modal] filePath=${filePath}, cwd=${cwd}, resolved=${resolved}`);

    if (!resolved.startsWith(normalizedCwd) && resolved !== path.resolve(cwd)) {
      logger.warn(`Path traversal blocked: ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const MODAL_MAX_BLOCKS = 98;
      const blocksNeeded = Math.ceil(content.length / 2850);

      let modal: any;
      if (blocksNeeded <= MODAL_MAX_BLOCKS) {
        modal = buildFileContentModal(filePath, content);
      } else {
        modal = buildFileChunksModal(filePath, lines.length);
      }
      modal.private_metadata = threadTs;

      const openResp = await slackViewsOpen(app.client.token, body.trigger_id, modal);
      if (!openResp.ok) {
        logger.error(`[file-modal] views.open failed: ${openResp.error} | detail: ${JSON.stringify(openResp.response_metadata?.messages || [])} | view_json_length: ${JSON.stringify(modal).length}`);
      }
    } catch (err: any) {
      logger.error(`[file-modal] Error opening file modal`, { filePath, error: err?.message || String(err) });
      const errorMsg = err?.code === 'ENOENT'
        ? `ファイルが見つかりません: \`${filePath}\``
        : `ファイル表示エラー: ${err?.message || 'unknown'}`;
      const errorModal = {
        type: 'modal',
        title: { type: 'plain_text', text: 'エラー' },
        close: { type: 'plain_text', text: '閉じる' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: errorMsg },
        }],
      };
      await slackViewsOpen(app.client.token, body.trigger_id, errorModal);
    }
  });

  // --- File Chunk Modal Action ---
  app.action(/^view_file_chunk:/, async ({ ack, body }: any) => {
    await ack();
    const value = body.actions?.[0]?.value;
    if (!value) return;

    const lastColon2 = value.lastIndexOf(':');
    const lastColon1 = value.lastIndexOf(':', lastColon2 - 1);
    const filePath = value.substring(0, lastColon1);
    const startLine = parseInt(value.substring(lastColon1 + 1, lastColon2), 10);
    const endLine = parseInt(value.substring(lastColon2 + 1), 10);

    if (!filePath || isNaN(startLine) || isNaN(endLine)) return;

    const privateMetadata = body.view?.private_metadata || '';
    const entry = privateMetadata ? sessionIndexStore.findByThreadTs(privateMetadata) : null;
    const cwd = entry?.projectPath || process.cwd();

    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd) + path.sep;

    if (!resolved.startsWith(normalizedCwd) && resolved !== path.resolve(cwd)) {
      logger.warn(`Path traversal blocked: ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const chunk = lines.slice(startLine - 1, endLine).join('\n');
      const modal = buildFileChunkModal(filePath, chunk, startLine, endLine);
      await slackViewsPush(app.client.token, body.trigger_id, modal);
    } catch {
      const modal = {
        type: 'modal',
        title: { type: 'plain_text', text: 'エラー' },
        close: { type: 'plain_text', text: '閉じる' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `ファイルが見つかりません: \`${filePath}\`` },
        }],
      };
      await slackViewsPush(app.client.token, body.trigger_id, modal);
    }
  });

  // --- Start ---
  await startApp(app);

  const authTestResult = await app.client.auth.test();
  const botUserId = authTestResult.user_id!;
  logger.info(`Bot user ID resolved: ${botUserId}`);

  const channelScheduler = new ChannelScheduler(
    path.join(config.dataDir, 'channels'),
    async (chId, trigger) => {
      try {
        const result = await app.client.chat.postMessage({
          channel: chId,
          text: `⏰ 定時実行: ${trigger.name}`,
        });
        if (!result.ts) {
          logger.error(`Failed to post trigger message to ${chId}`);
          return;
        }

        const triggerThreadTs = result.ts;
        const triggerProjectPath = channelProjectManager.getProjectPath(chId);

        let triggerModel = 'sonnet';
        try {
          const settings = JSON.parse(fs.readFileSync(path.join(triggerProjectPath, '.claude', 'settings.json'), 'utf-8'));
          triggerModel = settings.model || 'sonnet';
        } catch { /* default */ }

        const triggerContext = await channelProjectManager.buildContext(chId);
        const triggerSessionId = crypto.randomUUID();

        const triggerSession = await coordinator.getOrCreateSession({
          sessionId: triggerSessionId,
          userId: chId,
          model: triggerModel,
          projectPath: triggerProjectPath,
          isResume: false,
          bridgeContext: triggerContext,
          maxAliveOverride: 3,
        });

        sessionIndexStore.register({
          cliSessionId: triggerSessionId,
          threadTs: triggerThreadTs,
          channelId: chId,
          userId: chId,
          projectPath: triggerProjectPath,
          name: trigger.name,
          model: triggerModel,
          status: 'active',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        });

        wireSessionOutput(triggerSession, chId, triggerThreadTs, reactionManager, app.client, sessionIndexStore, triggerProjectPath);
        activeMessageTs.set(triggerSession.sessionId, result.ts);
        await reactionManager.addSpawning(chId, result.ts);
        triggerSession.sendInitialPrompt(trigger.prompt);

        await waitForInit(triggerSession).catch(async (err) => {
          triggerSession.end();
          await app.client.chat.postMessage({
            channel: chId,
            thread_ts: triggerThreadTs,
            text: `❌ 定時実行 "${trigger.name}" の起動に失敗: ${(err as Error).message}`,
          });
        });
      } catch (err) {
        logger.error(`Trigger failed: ${chId}/${trigger.name}`, err);
      }
    },
  );

  channelScheduler.loadAll();

  logger.info('Claude Code Slack Bridge is running (Phase 2)');

  // Prevent Slack SDK's reconnection failure from crashing the process.
  // When WiFi drops, the SDK's internal reconnect throws RequestError as
  // an unhandled rejection. We catch it here to keep the process alive
  // until NetworkWatcher detects WiFi recovery and triggers a clean restart.
  let isShuttingDown = false;

  // Socket Mode WebSocket health monitor — logs state every 5 min,
  // triggers restart if isActive() === false.
  // shutdown callback is assigned later to avoid TDZ.
  const socketWatchdog = new SocketWatchdog({
    app,
    shutdown: async (signal: string) => shutdown(signal),
  });
  process.on('unhandledRejection', (reason: unknown) => {
    if (isShuttingDown) return;
    logger.error('[Resilience] Unhandled rejection caught (crash prevented)', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // Update auto-update blocked messages if any
  const autoUpdateNotifyFile = path.join(os.homedir(), '.claude-slack-pipe', 'auto-update-notify.json');
  try {
    if (fs.existsSync(autoUpdateNotifyFile)) {
      const raw = JSON.parse(fs.readFileSync(autoUpdateNotifyFile, 'utf-8'));
      fs.unlinkSync(autoUpdateNotifyFile);
      for (const msg of raw.messages || []) {
        if (!msg.channel || !msg.ts) continue;
        try {
          await app.client.chat.update({
            channel: msg.channel,
            ts: msg.ts,
            text: '✅ 自動更新が完了しました。通常通り使えます。',
          });
        } catch (err) {
          logger.warn('[AutoUpdater] Failed to update blocked message', {
            channel: msg.channel, ts: msg.ts,
            error: (err as Error).message,
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[AutoUpdater] Failed to process notify file', { error: (err as Error).message });
  }

  // Update restart message if pending
  const restartPendingFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
  try {
    if (fs.existsSync(restartPendingFile)) {
      const raw = JSON.parse(fs.readFileSync(restartPendingFile, 'utf-8'));
      fs.unlinkSync(restartPendingFile);

      // Home tab restart recovery
      if (raw.homeTabUserId) {
        restartCompletePendingUser = raw.homeTabUserId;
        try {
          await homeTabHandler.publishHomeTab(raw.homeTabUserId, 'completed');
        } catch (err) {
          logger.warn('Failed to publish restart-complete home tab', {
            userId: raw.homeTabUserId,
            error: (err as Error).message,
          });
        }
        // Retry after delay in case Socket Mode wasn't connected yet
        const pendingUser = raw.homeTabUserId;
        setTimeout(async () => {
          if (restartCompletePendingUser === pendingUser) {
            restartCompletePendingUser = null;
            try {
              await homeTabHandler.publishHomeTab(pendingUser, 'completed');
            } catch { /* best-effort */ }
          }
        }, 5000);
      }

      // Support both old format ({ channel, ts }) and new format ({ messages: [...] })
      const messages: Array<{ channel: string; ts: string }> =
        raw.messages ? raw.messages : [raw];

      for (const pending of messages) {
        if (!pending.channel || !pending.ts) continue;
        try {
          await app.client.chat.update({
            channel: pending.channel,
            ts: pending.ts,
            text: '✅ Bridgeの再起動が完了しました',
          });
        } catch (err) {
          logger.warn('Failed to update restart message', {
            channel: pending.channel, ts: pending.ts,
            error: (err as Error).message,
          });
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to process restart-pending file', { error: (err as Error).message });
  }

  // --- WiFi resilience: auto-reconnect on network change ---
  const networkWatcher = new NetworkWatcher();

  networkWatcher.on('disconnected', () => {
    if (isShuttingDown) return;
    logger.warn('[Resilience] WiFi disconnected');
    // Notification is deferred to reconnect — network is already down at this point
  });

  networkWatcher.on('reconnected', async () => {
    if (isShuttingDown) return;
    logger.info('[Resilience] WiFi reconnected, restarting Bridge via launchd');

    // Wait for DHCP/DNS to stabilize
    await new Promise((r) => setTimeout(r, 2000));

    // Notify recently active sessions (within 10 minutes)
    // ISO 8601 strings compare lexicographically in time order
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recentSessions = sessionIndexStore.getActive()
      .filter((e) => e.lastActiveAt >= cutoff);

    const pendingMessages: Array<{ channel: string; ts: string; thread_ts: string }> = [];
    for (const entry of recentSessions) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await app.client.chat.postMessage({
            channel: entry.channelId,
            thread_ts: entry.threadTs,
            text: '🔄 PCのWiFiが切断されたため一時停止していました。再接続を検知したのでBridgeを再起動しています...',
          });
          if (result.ts) {
            pendingMessages.push({
              channel: entry.channelId,
              ts: result.ts,
              thread_ts: entry.threadTs,
            });
          }
          break;
        } catch {
          if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    // Save pending messages for the new process to update
    if (pendingMessages.length > 0) {
      const restartFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
      try {
        fs.writeFileSync(restartFile, JSON.stringify({ messages: pendingMessages }));
      } catch { /* best-effort */ }
    }

    // Reuse existing shutdown flow (same as /restart-bridge)
    await shutdown('wifi-reconnect');
  });

  networkWatcher.start();

  // Auto-updater (assigned after shutdown definition to avoid TDZ)
  let autoUpdater: AutoUpdater | null = null;

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    autoUpdater?.stop();
    logger.info(`Received ${signal}, shutting down...`);
    // End all alive sessions
    for (const entry of sessionIndexStore.getActive()) {
      coordinator.endSession(entry.cliSessionId);
    }
    // Remove brain reactions from active messages (best-effort)
    const reactionCleanups: Promise<void>[] = [];
    for (const [sessionId, messageTs] of activeMessageTs) {
      const entry = sessionIndexStore.get(sessionId);
      if (entry) {
        reactionCleanups.push(
          reactionManager.removeProcessing(entry.channelId, messageTs).catch(() => {})
        );
      }
    }
    await Promise.allSettled(reactionCleanups);
    activeMessageTs.clear();
    tunnelManager.stopAll();
    networkWatcher.stop();
    channelScheduler.stop();
    socketWatchdog.stop();
    // Clear crash history on intentional restart so it doesn't trigger circuit breaker
    if ((signal === 'restart-bridge' || signal === 'wifi-reconnect' || signal === 'auto-update' || signal === 'websocket-dead') && process.env.MANAGED_BY_LAUNCHD) {
      const crashFile = path.join(os.homedir(), '.claude-slack-pipe', 'crash-history.json');
      try { fs.writeFileSync(crashFile, '[]'); } catch { /* best-effort */ }
    }
    await app.stop();
    process.exit(0);
  };

  // Initialize auto-updater: polls git for updates and restarts when idle
  autoUpdater = new AutoUpdater({
    sessionCoordinator: coordinator,
    shutdown,
    interval: config.autoUpdateIntervalMs,
    enabled: config.autoUpdateEnabled,
    projectRoot: process.cwd(),
  });

  coordinator.onIdleCallback = () => {
    autoUpdater!.onSessionIdle().catch((err) => {
      logger.warn('[AutoUpdater] onSessionIdle failed', { error: err?.message });
    });
    // Reload channel schedules on session idle
    for (const chId of channelProjectManager.listChannelIds()) {
      channelScheduler.loadChannel(chId);
    }
  };

  autoUpdater.start();
  socketWatchdog.start();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: err?.message || err });
  process.exit(1);
});
