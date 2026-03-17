interface SlackClient {
  chat: {
    postEphemeral: (args: any) => Promise<any>;
  };
}

export interface StatusParams {
  channelId: string;
  threadTs: string;
  userId: string;
  sessionInfo: {
    sessionId: string;
    model: string;
    projectPath: string;
    totalCost: number;
    totalTokens: number;
    turnCount: number;
    processState: string;
    startedAt: string;
  };
}

export interface EndParams {
  channelId: string;
  threadTs: string;
  userId: string;
  sessionId: string;
  totalCost: number;
  totalTokens: number;
  turnCount: number;
  duration: string;
  onEnd: () => Promise<void>;
}

export interface RestartParams {
  channelId: string;
  threadTs: string;
  userId: string;
  sessionId: string;
  onRestart: () => Promise<void>;
}

export class BridgeCommandHandler {
  constructor(private readonly client: SlackClient) {}

  async handleStatus(params: StatusParams): Promise<void> {
    const { channelId, userId, sessionInfo } = params;
    const {
      sessionId,
      model,
      projectPath,
      totalCost,
      totalTokens,
      turnCount,
      processState,
      startedAt,
    } = sessionInfo;

    const text = [
      `📋 Session Status`,
      `Session: ${sessionId} | Started: ${startedAt}`,
      `📁 ${projectPath}`,
      `Model: ${model}`,
      `💰 Total: $${totalCost} | 📊 ${totalTokens} tokens | ${turnCount} turns`,
      `⚡ Process: ${processState}`,
    ].join('\n');

    await this.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
    });
  }

  async handleEnd(params: EndParams): Promise<void> {
    const { channelId, userId, totalCost, totalTokens, turnCount, duration, onEnd } = params;

    await onEnd();

    const text = [
      `✅ Session ended.`,
      `💰 Total: $${totalCost} | 📊 ${totalTokens} tokens | ${turnCount} turns | Duration: ${duration}`,
    ].join('\n');

    await this.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
    });
  }

  async handleRestart(params: RestartParams): Promise<void> {
    const { channelId, userId, sessionId, onRestart } = params;

    await onRestart();

    await this.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `🔄 Session ${sessionId} restarted.`,
    });
  }
}
