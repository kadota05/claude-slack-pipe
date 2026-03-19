// src/streaming/localhost-rewriter.ts

// Matches local URLs, stopping at whitespace, parens, and Slack mrkdwn special chars (<, >, |)
const LOCALHOST_URL_PATTERN =
  /https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?[^\s)<>|]*/g;

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
  const regex = new RegExp(LOCALHOST_URL_PATTERN.source, 'g');

  let match;
  while ((match = regex.exec(text)) !== null) {
    const host = match[1];
    if (!isPrivateIp(host)) continue;

    const port = match[2] ? parseInt(match[2].slice(1), 10) : 80;
    results.push({ url: match[0], host, port });
  }

  return results;
}

export function rewriteLocalUrls(
  text: string,
  urlMap: Map<string, string>
): string {
  if (urlMap.size === 0) return text;

  // Sort by URL length descending to avoid partial match issues
  // e.g. "http://localhost:3000/path" before "http://localhost:3000"
  const sortedEntries = [...urlMap.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  let result = text;
  for (const [originalUrl, tunnelUrl] of sortedEntries) {
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // First: replace Slack mrkdwn links <localUrl|text> with <tunnelUrl|text>
    result = result.replace(
      new RegExp(`<${escaped}\\|([^>]+)>`, 'g'),
      `<${tunnelUrl}|$1>`
    );

    // Then: replace bare occurrences (not inside mrkdwn links)
    // Strip protocol to avoid Slack's auto-linking which breaks <url|text> mrkdwn links
    const displayUrl = originalUrl.replace(/^https?:\/\//, '');
    result = result.replace(
      new RegExp(`(?<![<|])${escaped}`, 'g'),
      `\`${displayUrl}\` （ <${tunnelUrl}|Slackからはこちら> ）`
    );
  }

  return result;
}
