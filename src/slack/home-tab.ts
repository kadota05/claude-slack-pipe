import { buildHomeTabBlocks, getTimeAgo } from './block-builder.js';
import { logger } from '../utils/logger.js';
import type { RecentSessionScanner } from '../store/recent-session-scanner.js';

export class HomeTabHandler {
  constructor(
    private readonly client: any,
    private readonly userPrefStore: any,
    private readonly projectStore: any,
    private readonly recentSessionScanner: RecentSessionScanner,
  ) {}

  async publishHomeTab(userId: string): Promise<void> {
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

    const blocks = buildHomeTabBlocks({
      model: prefs.defaultModel,
      directoryId: prefs.activeDirectoryId,
      directories,
      recentSessions,
    });

    try {
      await this.client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks },
      });
    } catch (err) {
      logger.error('Failed to publish home tab', { error: (err as Error).message });
    }
  }
}
