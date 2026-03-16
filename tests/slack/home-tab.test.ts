import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HomeTabHandler } from '../../src/slack/home-tab.js';

describe('HomeTabHandler (phase2)', () => {
  let handler: HomeTabHandler;
  let mockClient: any;
  let mockUserPrefStore: any;
  let mockSessionIndexStore: any;
  let mockProjectStore: any;

  beforeEach(() => {
    mockClient = { views: { publish: vi.fn().mockResolvedValue({ ok: true }) } };
    mockUserPrefStore = {
      get: vi.fn().mockReturnValue({ defaultModel: 'sonnet', activeDirectoryId: null }),
    };
    mockSessionIndexStore = {
      getActive: vi.fn().mockReturnValue([]),
      getEnded: vi.fn().mockReturnValue([]),
      listByDirectory: vi.fn().mockReturnValue([]),
    };
    mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([
        { name: 'myapp', path: '/home/user/myapp' },
      ]),
    };
    handler = new HomeTabHandler(mockClient, mockUserPrefStore, mockSessionIndexStore, mockProjectStore);
  });

  it('publishes home tab with correct user preferences', async () => {
    await handler.publishHomeTab('U001');
    expect(mockClient.views.publish).toHaveBeenCalledOnce();
    expect(mockUserPrefStore.get).toHaveBeenCalledWith('U001');
  });

  it('filters sessions by active directory when set', async () => {
    mockUserPrefStore.get.mockReturnValue({ defaultModel: 'sonnet', activeDirectoryId: 'myapp' });
    await handler.publishHomeTab('U001');
    expect(mockSessionIndexStore.listByDirectory).toHaveBeenCalled();
  });

  it('uses getActive/getEnded when no directory selected', async () => {
    await handler.publishHomeTab('U001');
    expect(mockSessionIndexStore.getActive).toHaveBeenCalled();
    expect(mockSessionIndexStore.getEnded).toHaveBeenCalled();
  });
});
