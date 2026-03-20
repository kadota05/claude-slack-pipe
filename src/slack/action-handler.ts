export class ActionHandler {
  constructor(
    private readonly userPrefStore: any,
    private readonly coordinator: any,
    private readonly homeTab: any,
  ) {}

  async handleSetDefaultModel(userId: string, model: string): Promise<void> {
    this.userPrefStore.setModel(userId, model);
    this.coordinator.broadcastControl({ type: 'control', subtype: 'set_model', model });
    await this.homeTab.publishHomeTab(userId);
  }

  async handleSetDirectory(userId: string, directoryId: string): Promise<void> {
    this.userPrefStore.setDirectory(userId, directoryId);
    // Phase 1: Publish with star button hidden to prevent stale interactions
    // during Slack mobile's view re-render transition (~1-2s).
    await this.homeTab.publishHomeTab(userId, undefined, { hideStarButton: true });
    // Phase 2: Re-publish with star button after client settles.
    setTimeout(() => {
      this.homeTab.publishHomeTab(userId);
    }, 1500);
  }

  async handleToggleStar(userId: string, directoryId: string): Promise<void> {
    this.userPrefStore.toggleStar(userId, directoryId);
    await this.homeTab.publishHomeTab(userId);
  }
}
