import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionHandler } from '../../src/slack/action-handler.js';

describe('ActionHandler', () => {
  let handler: ActionHandler;
  let mockUserPrefStore: any;
  let mockCoordinator: any;
  let mockHomeTab: any;

  beforeEach(() => {
    mockUserPrefStore = {
      setModel: vi.fn(),
      setDirectory: vi.fn(),
      toggleStar: vi.fn(),
    };
    mockCoordinator = {
      broadcastControl: vi.fn(),
    };
    mockHomeTab = {
      publishHomeTab: vi.fn().mockResolvedValue(undefined),
    };
    handler = new ActionHandler(mockUserPrefStore, mockCoordinator, mockHomeTab);
  });

  describe('handleSetDefaultModel', () => {
    it('updates preference and broadcasts to alive sessions', async () => {
      await handler.handleSetDefaultModel('U001', 'opus');
      expect(mockUserPrefStore.setModel).toHaveBeenCalledWith('U001', 'opus');
      expect(mockCoordinator.broadcastControl).toHaveBeenCalledWith({
        type: 'control', subtype: 'set_model', model: 'opus',
      });
      expect(mockHomeTab.publishHomeTab).toHaveBeenCalledWith('U001');
    });
  });

  describe('handleSetDirectory', () => {
    it('updates preference and refreshes home tab', async () => {
      await handler.handleSetDirectory('U001', 'dir-123');
      expect(mockUserPrefStore.setDirectory).toHaveBeenCalledWith('U001', 'dir-123');
      expect(mockHomeTab.publishHomeTab).toHaveBeenCalledWith('U001');
    });
  });

  describe('handleToggleStar', () => {
    it('toggles star and refreshes home tab', async () => {
      await handler.handleToggleStar('U001', 'dir-abc');
      expect(mockUserPrefStore.toggleStar).toHaveBeenCalledWith('U001', 'dir-abc');
      expect(mockHomeTab.publishHomeTab).toHaveBeenCalledWith('U001');
    });
  });
});
