import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HomeTabHandler } from '../../src/slack/home-tab.js';

describe('HomeTabHandler (phase2)', () => {
  let handler: HomeTabHandler;
  let mockClient: any;
  let mockUserPrefStore: any;
  let mockProjectStore: any;
  let mockRecentSessionScanner: any;

  beforeEach(() => {
    mockClient = { views: { publish: vi.fn().mockResolvedValue({ ok: true }) } };
    mockUserPrefStore = {
      get: vi.fn().mockReturnValue({ defaultModel: 'sonnet', activeDirectoryId: null }),
    };
    mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([
        { name: 'myapp', workingDirectory: '/home/user/myapp' },
      ]),
    };
    mockRecentSessionScanner = {
      scan: vi.fn().mockResolvedValue([]),
    };
    handler = new HomeTabHandler(mockClient, mockUserPrefStore, mockProjectStore, mockRecentSessionScanner);
  });

  it('publishes home tab with correct user preferences', async () => {
    await handler.publishHomeTab('U001');
    expect(mockClient.views.publish).toHaveBeenCalledOnce();
    expect(mockUserPrefStore.get).toHaveBeenCalledWith('U001');
  });

  it('scans recent sessions', async () => {
    await handler.publishHomeTab('U001');
    expect(mockRecentSessionScanner.scan).toHaveBeenCalled();
  });
});
