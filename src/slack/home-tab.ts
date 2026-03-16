import { buildHomeTabBlocks } from './block-builder.js';
import { logger } from '../utils/logger.js';

export class HomeTabHandler {
  constructor(
    private readonly client: any,
    private readonly userPrefStore: any,
    private readonly sessionIndexStore: any,
    private readonly projectStore: any,
  ) {}

  async publishHomeTab(userId: string, page = 0): Promise<void> {
    const prefs = this.userPrefStore.get(userId);
    const projects = this.projectStore.getProjects();
    const directories = projects.map((p: any) => ({
      id: p.name,
      name: p.name,
      path: p.path,
    }));

    let activeSessions: any[];
    let endedSessions: any[];

    if (prefs.activeDirectoryId) {
      const all = this.sessionIndexStore.listByDirectory(
        projects.find((p: any) => p.name === prefs.activeDirectoryId)?.path || ''
      );
      activeSessions = all.filter((s: any) => s.status === 'active');
      endedSessions = all.filter((s: any) => s.status === 'ended');
    } else {
      activeSessions = this.sessionIndexStore.getActive();
      endedSessions = this.sessionIndexStore.getEnded();
    }

    const sessionsPerPage = 20;
    const totalSessions = activeSessions.length + endedSessions.length;
    const totalPages = Math.max(1, Math.ceil(totalSessions / sessionsPerPage));

    const blocks = buildHomeTabBlocks({
      model: prefs.defaultModel,
      directoryId: prefs.activeDirectoryId,
      directories,
      activeSessions,
      endedSessions,
      page,
      totalPages,
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
