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
    await this.homeTab.publishHomeTab(userId);
  }
}
