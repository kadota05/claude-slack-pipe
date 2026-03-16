import type { ProjectStore } from '../store/project-store.js';
import type { SessionStore } from '../store/session-store.js';
import { buildHomeTabBlocks } from './block-builder.js';
import { logger } from '../utils/logger.js';

type Block = Record<string, any>;

export class HomeTabHandler {
  constructor(
    private readonly projectStore: ProjectStore,
    private readonly sessionStore: SessionStore,
  ) {}

  buildHomeView(): Block[] {
    const projects = this.projectStore.getProjects();
    const activeSessions = this.sessionStore.getActiveSessions();

    return buildHomeTabBlocks(
      projects.map((p) => ({
        id: p.id,
        projectPath: p.projectPath,
        sessionCount: p.sessionCount,
      })),
      activeSessions.map((s) => ({
        name: s.name,
        sessionId: s.sessionId,
        lastActiveAt: s.lastActiveAt,
        threadTs: s.threadTs,
        dmChannelId: s.dmChannelId,
      })),
    );
  }

  async publishHomeTab(
    client: { views: { publish: (args: any) => Promise<any> } },
    userId: string,
  ): Promise<void> {
    try {
      const blocks = this.buildHomeView();
      await client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks,
        },
      });
      logger.debug('Home tab published', { userId });
    } catch (err) {
      logger.error('Failed to publish home tab', { userId, error: err });
    }
  }
}
