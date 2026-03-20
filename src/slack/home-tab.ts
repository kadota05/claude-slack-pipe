import { buildHomeTabBlocks, getTimeAgo } from './block-builder.js';
import { logger } from '../utils/logger.js';
import type { RecentSessionScanner } from '../store/recent-session-scanner.js';

export class HomeTabHandler {
  // Per-user publish queue to prevent concurrent views.publish calls.
  // Rapid actions (e.g. directory change + star toggle) can fire two
  // publishes simultaneously, confusing the Slack mobile client.
  private publishQueue = new Map<string, Promise<void>>();

  constructor(
    private readonly client: any,
    private readonly userPrefStore: any,
    private readonly projectStore: any,
    private readonly recentSessionScanner: RecentSessionScanner,
  ) {}

  async publishHomeTab(
    userId: string,
    restartStatus?: 'idle' | 'restarting' | 'completed',
    options?: { hideStarButton?: boolean },
  ): Promise<void> {
    const prev = this.publishQueue.get(userId) ?? Promise.resolve();
    const next = prev.then(() => this.doPublishHomeTab(userId, restartStatus, options)).catch(() => {});
    this.publishQueue.set(userId, next);
    return next;
  }

  private async doPublishHomeTab(
    userId: string,
    restartStatus?: 'idle' | 'restarting' | 'completed',
    options?: { hideStarButton?: boolean },
  ): Promise<void> {
    const prefs = this.userPrefStore.get(userId);
    const projects = this.projectStore.getProjects();
    const directories = projects
      .filter((p: any) => p.workingDirectory)
      .map((p: any) => {
        const parts = p.workingDirectory.split('/').filter(Boolean);
        const displayName = parts.slice(-2).join('/') || p.id;
        return {
          id: p.id,
          name: displayName.slice(0, 75),
          path: p.projectPath,
        };
      })
      .slice(0, 100);

    let recentSessions: Array<{
      timeAgo: string;
      firstPromptPreview: string;
      projectPath: string;
    }> = [];

    try {
      const scanned = await this.recentSessionScanner.scan();
      recentSessions = scanned.map(s => ({
        timeAgo: getTimeAgo(s.mtime),
        firstPromptPreview: s.firstPromptPreview,
        projectPath: s.projectPath,
      }));
    } catch (err) {
      logger.error('Failed to scan recent sessions', { error: (err as Error).message });
    }

    logger.info('[publishHomeTab] building blocks', {
      userId,
      directoryId: prefs.activeDirectoryId,
      starredDirectoryIds: prefs.starredDirectoryIds,
      dirCount: directories.length,
    });

    const blocks = buildHomeTabBlocks({
      model: prefs.defaultModel,
      directoryId: prefs.activeDirectoryId,
      directories,
      recentSessions,
      restartStatus,
      starredDirectoryIds: prefs.starredDirectoryIds ?? [],
      hideStarButton: options?.hideStarButton,
    });

    // Use private_metadata with timestamp to force Slack to recognize view as new.
    // Without this, Slack mobile may skip re-rendering after static_select interactions.
    const view = {
      type: 'home' as const,
      blocks,
      private_metadata: JSON.stringify({ ts: Date.now() }),
    };

    try {
      const result = await this.client.views.publish({ user_id: userId, view });
      logger.info('[publishHomeTab] views.publish result', { ok: result?.ok, error: result?.error });
    } catch (err) {
      logger.error('[publishHomeTab] views.publish FAILED', { error: (err as Error).message, stack: (err as Error).stack });
    }
  }
}
