// src/streaming/slack-action-executor.ts
import { logger } from '../utils/logger.js';
import { RateLimitTracker } from './rate-limit-tracker.js';
import { GracefulDegradation } from './graceful-degradation.js';
import type { SlackAction, SlackApiMethod, ExecutorResult } from './types.js';

const ACTION_TO_METHOD: Record<SlackAction['type'], SlackApiMethod> = {
  postMessage: 'postMessage',
  update: 'update',
  addReaction: 'addReaction',
  removeReaction: 'removeReaction',
};

export class SlackActionExecutor {
  readonly rateLimiter = new RateLimitTracker();

  constructor(private readonly client: any) {}

  async execute(action: SlackAction): Promise<ExecutorResult> {
    const method = ACTION_TO_METHOD[action.type];

    // Graceful Degradation check
    const level = GracefulDegradation.getLevel(this.rateLimiter.getMaxUtilization());
    if (!GracefulDegradation.shouldExecute(level, action.priority)) {
      logger.debug(`Degradation ${level}: skipping P${action.priority} ${action.type}`);
      return { ok: false, error: 'degraded_skip' };
    }

    if (!this.rateLimiter.canProceed(method)) {
      logger.warn(`Rate limit would be exceeded for ${method}, skipping`);
      return { ok: false, error: 'rate_limit_preemptive' };
    }

    try {
      const result = await this.callApi(action);
      this.rateLimiter.record(method); // Record AFTER success
      return result;
    } catch (err) {
      return this.handleError(err, method);
    }
  }

  private async callApi(action: SlackAction): Promise<ExecutorResult> {
    switch (action.type) {
      case 'postMessage': {
        // Use fetch with JSON to avoid @slack/web-api's form-urlencoded encoding
        // which breaks Slack mrkdwn link syntax <url|text>
        const resp = await this.slackApiJson('chat.postMessage', {
          channel: action.channel,
          thread_ts: action.threadTs,
          blocks: action.blocks,
          text: action.text || '',
        });
        return { ok: true, ts: resp.ts };
      }
      case 'update': {
        const resp = await this.slackApiJson('chat.update', {
          channel: action.channel,
          ts: action.messageTs,
          blocks: action.blocks,
          text: action.text || '',
        });
        return { ok: true, ts: resp.ts };
      }
      case 'addReaction': {
        await this.client.reactions.add({
          channel: action.channel,
          timestamp: action.targetTs,
          name: action.emoji,
        });
        return { ok: true };
      }
      case 'removeReaction': {
        await this.client.reactions.remove({
          channel: action.channel,
          timestamp: action.targetTs,
          name: action.emoji,
        });
        return { ok: true };
      }
    }
  }

  private async slackApiJson(method: string, body: Record<string, unknown>): Promise<any> {
    const token = this.client.token;
    logger.info(`[slackApiJson] ${method} token=${token ? 'present' : 'MISSING'} body=${JSON.stringify(body).substring(0, 500)}`);
    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    logger.info(`[slackApiJson] ${method} response ok=${data.ok} error=${data.error || 'none'}`);
    if (!data.ok) {
      const err = new Error(`Slack API error: ${data.error}`);
      (err as any).code = data.error === 'ratelimited' ? 'slack_webapi_rate_limited' : data.error;
      (err as any).data = { headers: Object.fromEntries(resp.headers.entries()) };
      throw err;
    }
    return data;
  }

  private handleError(err: unknown, method: SlackApiMethod): ExecutorResult {
    const error = err as any;
    const message = error?.message || String(err);

    if (error?.code === 'slack_webapi_rate_limited') {
      const retryAfter = parseInt(error?.data?.headers?.['retry-after'] || '30', 10);
      const retryAfterMs = retryAfter * 1000;
      this.rateLimiter.recordRateLimited(method, retryAfterMs);
      logger.warn(`429 rate limited on ${method}, retry after ${retryAfter}s`);
      return { ok: false, error: 'rate_limited', retryAfterMs };
    }

    logger.error(`Slack API error on ${method}`, { error: message });
    return { ok: false, error: message };
  }
}
