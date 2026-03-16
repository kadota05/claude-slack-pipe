import { describe, it, expect, vi } from 'vitest';
import { HomeTabHandler } from '../../src/slack/home-tab.js';

describe('HomeTabHandler', () => {
  it('should build home tab view with projects and sessions', () => {
    const mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([
        { id: '-Users-user-dev-webapp', projectPath: '/Users/user/dev/webapp', sessionCount: 3, lastModified: new Date() },
      ]),
    };

    const mockSessionStore = {
      getActiveSessions: vi.fn().mockReturnValue([
        {
          sessionId: 'abc-123',
          name: 'webapp: auth',
          lastActiveAt: new Date(),
          threadTs: '1.000',
          dmChannelId: 'D123',
        },
      ]),
    };

    const handler = new HomeTabHandler(
      mockProjectStore as any,
      mockSessionStore as any,
    );

    const blocks = handler.buildHomeView();

    expect(blocks.length).toBeGreaterThan(0);

    // Should have header
    const header = blocks.find((b: any) => b.type === 'header');
    expect(header).toBeDefined();

    // Should have project
    const projectBlock = blocks.find((b: any) =>
      b.text?.text?.includes('webapp'),
    );
    expect(projectBlock).toBeDefined();

    // Should have active session
    const sessionBlock = blocks.find((b: any) =>
      b.text?.text?.includes('webapp: auth'),
    );
    expect(sessionBlock).toBeDefined();
  });

  it('should show empty state when no projects', () => {
    const mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([]),
    };
    const mockSessionStore = {
      getActiveSessions: vi.fn().mockReturnValue([]),
    };

    const handler = new HomeTabHandler(
      mockProjectStore as any,
      mockSessionStore as any,
    );

    const blocks = handler.buildHomeView();
    const emptyBlock = blocks.find((b: any) =>
      b.text?.text?.includes('No projects'),
    );
    expect(emptyBlock).toBeDefined();
  });
});
