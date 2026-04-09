// src/streaming/localhost-rewriter.ts

const LOCAL_HOST_NAMES = `(localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|0\\.0\\.0\\.0|\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})`;
// Exclude non-ASCII (\\u0080+) to avoid matching CJK characters
// that follow URLs without a space (e.g. "localhost:8080を開く")
const URL_TAIL = `[^\\s)<>|\`\\u0080-\\uffff]*`;

// With protocol: port is optional (defaults to 80)
const WITH_PROTOCOL = new RegExp(`https?:\\/\\/${LOCAL_HOST_NAMES}(:\\d+)?${URL_TAIL}`, 'g');
// Without protocol: port is required to avoid matching bare "localhost" in text
const WITHOUT_PROTOCOL = new RegExp(`(?<![/\\w])${LOCAL_HOST_NAMES}(:\\d+)${URL_TAIL}`, 'g');

export interface LocalUrl {
  url: string;
  host: string;
  port: number;
}

export function isPrivateIp(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0') return true;

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;

  // 127.x.x.x (loopback)
  if (parts[0] === 127) return true;
  // 10.x.x.x
  if (parts[0] === 10) return true;
  // 172.16.0.0 - 172.31.255.255
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.x.x
  if (parts[0] === 192 && parts[1] === 168) return true;

  return false;
}

export function extractLocalUrls(text: string): LocalUrl[] {
  const results: LocalUrl[] = [];
  const seen = new Set<string>();

  for (const pattern of [WITH_PROTOCOL, WITHOUT_PROTOCOL]) {
    const regex = new RegExp(pattern.source, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const host = match[1];
      if (!isPrivateIp(host)) continue;

      const port = match[2] ? parseInt(match[2].slice(1), 10) : 80;
      const url = match[0].startsWith('http') ? match[0] : `http://${match[0]}`;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ url, host, port });
    }
  }

  return results;
}

import type { Block } from './types.js';

/**
 * Build Slack blocks for localhost access links.
 * - Tunnel success: URL button (opens tunnel URL in mobile browser)
 * - Tunnel failure: warning context block
 */
export function buildLocalhostAccessBlocks(
  localUrls: LocalUrl[],
  urlMap: Map<string, string>,
): Block[] {
  const blocks: Block[] = [];
  const buttons: any[] = [];
  const failedPorts: number[] = [];

  for (const { url, port } of localUrls) {
    const tunnelUrl = urlMap.get(url);
    if (tunnelUrl) {
      const displayUrl = url.replace(/^https?:\/\//, '');
      // Cache buster prevents Slack WebView from serving stale failure responses
      const sep = tunnelUrl.includes('?') ? '&' : '?';
      const cacheBustedUrl = `${tunnelUrl}${sep}_cb=${Date.now()}`;
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: `🌐 ${displayUrl}` },
        url: cacheBustedUrl,
        action_id: `tunnel_access:${buttons.length}`,
      });
    } else {
      if (!failedPorts.includes(port)) failedPorts.push(port);
    }
  }

  if (buttons.length > 0) {
    blocks.push({ type: 'divider' });
    for (let i = 0; i < buttons.length; i += 25) {
      blocks.push({ type: 'actions', elements: buttons.slice(i, i + 25) } as any);
    }
  }

  if (failedPorts.length > 0) {
    const ports = failedPorts.map(p => `localhost:${p}`).join(', ');
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `⚠️ ${ports} のモバイルアクセスリンクを準備できませんでした`,
      }],
    });
  }

  return blocks;
}
