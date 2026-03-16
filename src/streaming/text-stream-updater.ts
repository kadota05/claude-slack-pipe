import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import type { SlackAction } from './types.js';

interface TextStreamUpdaterConfig {
  channel: string;
  threadTs: string;
  onAction: (action: SlackAction) => void;
  getUpdateUtilization: () => number;
}

const MAX_TIMER_TICKS_WITHOUT_TS = 20; // Stop timer after ~20 ticks without messageTs

export class TextStreamUpdater {
  private textBuffer = '';
  private messageTs: string | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private ticksWithoutTs = 0;
  private readonly config: TextStreamUpdaterConfig;

  constructor(config: TextStreamUpdaterConfig) {
    this.config = config;
  }

  appendText(text: string): void {
    this.textBuffer += text;
    this.dirty = true;

    if (!this.messageTs && this.textBuffer.length === text.length) {
      // First text chunk: postMessage with streaming indicator
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      this.config.onAction({
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: this.buildBlocks(converted, false),
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
      this.startUpdateTimer();
    }
  }

  setMessageTs(ts: string): void {
    this.messageTs = ts;
  }

  getAccumulatedText(): string {
    return this.textBuffer;
  }

  finalize(): void {
    this.stopUpdateTimer();
    if (this.messageTs) {
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      this.config.onAction({
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.messageTs,
        blocks: this.buildBlocks(converted, true),
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
    }
    this.dirty = false;
  }

  dispose(): void {
    this.stopUpdateTimer();
  }

  private startUpdateTimer(): void {
    this.scheduleNextUpdate();
  }

  private scheduleNextUpdate(): void {
    this.updateTimer = setTimeout(() => {
      if (this.dirty && this.messageTs) {
        this.ticksWithoutTs = 0;
        const converted = convertMarkdownToMrkdwn(this.textBuffer);
        this.config.onAction({
          type: 'update',
          priority: 4,
          channel: this.config.channel,
          threadTs: this.config.threadTs,
          messageTs: this.messageTs,
          blocks: this.buildBlocks(converted, false),
          text: this.textBuffer.slice(0, 100),
          metadata: { messageType: 'text' },
        });
        this.dirty = false;
      } else if (!this.messageTs) {
        this.ticksWithoutTs++;
        if (this.ticksWithoutTs >= MAX_TIMER_TICKS_WITHOUT_TS) {
          // Safety: stop timer if messageTs was never set (e.g. postMessage failed)
          this.stopUpdateTimer();
          return;
        }
      }
      // Reschedule with dynamically recalculated interval
      this.scheduleNextUpdate();
    }, this.getInterval());
  }

  private stopUpdateTimer(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private getInterval(): number {
    const util = this.config.getUpdateUtilization();
    if (util < 0.4) return 1500;
    if (util < 0.6) return 2000;
    if (util < 0.8) return 3000;
    if (util < 0.9) return 5000;
    return 10000;
  }

  private buildBlocks(mrkdwn: string, isComplete: boolean): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    // Split into 2900-char sections (safety margin for 3000 limit)
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
      });
    }
    if (!isComplete) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':writing_hand: _入力中..._' }],
      });
    }
    return blocks;
  }
}
