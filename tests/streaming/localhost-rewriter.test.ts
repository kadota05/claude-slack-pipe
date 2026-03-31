// tests/streaming/localhost-rewriter.test.ts
import { describe, it, expect } from 'vitest';
import { isPrivateIp, extractLocalUrls, buildLocalhostAccessBlocks } from '../../src/streaming/localhost-rewriter.js';

describe('isPrivateIp', () => {
  it('returns true for localhost', () => {
    expect(isPrivateIp('localhost')).toBe(true);
  });

  it('returns true for 127.x.x.x', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });

  it('returns true for 0.0.0.0', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('returns true for 10.x.x.x', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
  });

  it('returns true for 172.16-31.x.x', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('returns true for 192.168.x.x', () => {
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.10')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('203.0.113.1')).toBe(false);
  });
});

describe('extractLocalUrls', () => {
  it('extracts localhost URL with port', () => {
    const result = extractLocalUrls('Server running at http://localhost:3000');
    expect(result).toEqual([{ url: 'http://localhost:3000', host: 'localhost', port: 3000 }]);
  });

  it('extracts localhost URL without port (defaults to 80)', () => {
    const result = extractLocalUrls('Visit http://localhost');
    expect(result).toEqual([{ url: 'http://localhost', host: 'localhost', port: 80 }]);
  });

  it('extracts URL with path', () => {
    const result = extractLocalUrls('Open http://localhost:5173/dashboard');
    expect(result).toEqual([{ url: 'http://localhost:5173/dashboard', host: 'localhost', port: 5173 }]);
  });

  it('extracts 127.0.0.1 URL', () => {
    const result = extractLocalUrls('http://127.0.0.1:8080/api');
    expect(result).toEqual([{ url: 'http://127.0.0.1:8080/api', host: '127.0.0.1', port: 8080 }]);
  });

  it('extracts private IP URL', () => {
    const result = extractLocalUrls('http://192.168.1.10:3000');
    expect(result).toEqual([{ url: 'http://192.168.1.10:3000', host: '192.168.1.10', port: 3000 }]);
  });

  it('ignores public IP URLs', () => {
    const result = extractLocalUrls('http://8.8.8.8:3000');
    expect(result).toEqual([]);
  });

  it('extracts multiple URLs', () => {
    const result = extractLocalUrls('Frontend: http://localhost:3000 API: http://localhost:8080');
    expect(result).toHaveLength(2);
    expect(result[0].port).toBe(3000);
    expect(result[1].port).toBe(8080);
  });

  it('returns empty for no URLs', () => {
    const result = extractLocalUrls('No URLs here');
    expect(result).toEqual([]);
  });

  it('extracts localhost URL without protocol (port required)', () => {
    const result = extractLocalUrls('`localhost:8765/fun.html` で動いてます');
    expect(result).toEqual([{ url: 'http://localhost:8765/fun.html', host: 'localhost', port: 8765 }]);
  });

  it('does not match bare localhost without port when no protocol', () => {
    const result = extractLocalUrls('connect to localhost for details');
    expect(result).toEqual([]);
  });

  it('does not include CJK characters in URL tail', () => {
    const result = extractLocalUrls('http://localhost:8080を開く');
    expect(result).toEqual([{ url: 'http://localhost:8080', host: 'localhost', port: 8080 }]);
  });

  it('does not include CJK characters in URL tail (without protocol)', () => {
    const result = extractLocalUrls('localhost:8080を開く');
    expect(result).toEqual([{ url: 'http://localhost:8080', host: 'localhost', port: 8080 }]);
  });
});

describe('buildLocalhostAccessBlocks', () => {
  it('builds URL button when tunnel succeeds', () => {
    const localUrls = [{ url: 'http://localhost:3000', host: 'localhost', port: 3000 }];
    const urlMap = new Map([['http://localhost:3000', 'https://abc123.trycloudflare.com']]);
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    expect(blocks).toHaveLength(2); // divider + actions
    expect(blocks[0]).toEqual({ type: 'divider' });
    expect((blocks[1] as any).type).toBe('actions');
    const button = (blocks[1] as any).elements[0];
    expect(button.text.text).toBe('🌐 localhost:3000');
    expect(button.url).toBe('https://abc123.trycloudflare.com');
  });

  it('builds multiple buttons for multiple URLs', () => {
    const localUrls = [
      { url: 'http://localhost:3000', host: 'localhost', port: 3000 },
      { url: 'http://localhost:8080', host: 'localhost', port: 8080 },
    ];
    const urlMap = new Map([
      ['http://localhost:3000', 'https://aaa.trycloudflare.com'],
      ['http://localhost:8080', 'https://bbb.trycloudflare.com'],
    ]);
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    expect(blocks).toHaveLength(2); // divider + actions
    const elements = (blocks[1] as any).elements;
    expect(elements).toHaveLength(2);
    expect(elements[0].url).toBe('https://aaa.trycloudflare.com');
    expect(elements[1].url).toBe('https://bbb.trycloudflare.com');
  });

  it('shows warning when tunnel fails', () => {
    const localUrls = [{ url: 'http://localhost:3000', host: 'localhost', port: 3000 }];
    const urlMap = new Map<string, string>(); // empty = all failed
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    expect(blocks).toHaveLength(1); // context only (no divider for failure-only)
    expect((blocks[0] as any).type).toBe('context');
    expect((blocks[0] as any).elements[0].text).toContain('localhost:3000');
    expect((blocks[0] as any).elements[0].text).toContain('⚠️');
  });

  it('shows both button and warning for partial success', () => {
    const localUrls = [
      { url: 'http://localhost:3000', host: 'localhost', port: 3000 },
      { url: 'http://localhost:8080', host: 'localhost', port: 8080 },
    ];
    const urlMap = new Map([['http://localhost:3000', 'https://aaa.trycloudflare.com']]);
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    expect(blocks).toHaveLength(3); // divider + actions + context
    expect((blocks[1] as any).elements[0].url).toBe('https://aaa.trycloudflare.com');
    expect((blocks[2] as any).elements[0].text).toContain('localhost:8080');
  });

  it('returns empty blocks when no URLs', () => {
    const blocks = buildLocalhostAccessBlocks([], new Map());
    expect(blocks).toEqual([]);
  });

  it('displays path in button text', () => {
    const localUrls = [{ url: 'http://localhost:5173/dashboard', host: 'localhost', port: 5173 }];
    const urlMap = new Map([['http://localhost:5173/dashboard', 'https://abc.trycloudflare.com/dashboard']]);
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    const button = (blocks[1] as any).elements[0];
    expect(button.text.text).toBe('🌐 localhost:5173/dashboard');
    expect(button.url).toBe('https://abc.trycloudflare.com/dashboard');
  });

  it('deduplicates failed ports', () => {
    const localUrls = [
      { url: 'http://localhost:3000', host: 'localhost', port: 3000 },
      { url: 'http://localhost:3000/api', host: 'localhost', port: 3000 },
    ];
    const urlMap = new Map<string, string>();
    const blocks = buildLocalhostAccessBlocks(localUrls, urlMap);

    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as any).elements[0].text;
    // Should mention port 3000 only once
    expect(text.match(/localhost:3000/g)).toHaveLength(1);
  });
});
