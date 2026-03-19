// tests/streaming/localhost-rewriter.test.ts
import { describe, it, expect } from 'vitest';
import { isPrivateIp, extractLocalUrls, rewriteLocalUrls } from '../../src/streaming/localhost-rewriter.js';

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
});

describe('rewriteLocalUrls', () => {
  it('rewrites localhost URL with tunnel URL', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:3000', 'https://abc123.trycloudflare.com'],
    ]);
    const result = rewriteLocalUrls(
      'Server running at http://localhost:3000',
      urlMap
    );
    expect(result).toBe(
      'Server running at `localhost:3000` （ <https://abc123.trycloudflare.com|Slackからはこちら> ）'
    );
  });

  it('rewrites multiple URLs', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:3000', 'https://aaa.trycloudflare.com'],
      ['http://localhost:8080', 'https://bbb.trycloudflare.com'],
    ]);
    const result = rewriteLocalUrls(
      'Frontend: http://localhost:3000 API: http://localhost:8080',
      urlMap
    );
    expect(result).toContain('`localhost:3000` （ <https://aaa.trycloudflare.com|Slackからはこちら> ）');
    expect(result).toContain('`localhost:8080` （ <https://bbb.trycloudflare.com|Slackからはこちら> ）');
  });

  it('leaves URL unchanged when no tunnel URL available', () => {
    const urlMap = new Map<string, string>();
    const result = rewriteLocalUrls(
      'Server running at http://localhost:3000',
      urlMap
    );
    expect(result).toBe('Server running at http://localhost:3000');
  });

  it('rewrites URL with path, mapping to base tunnel URL with path', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:5173/dashboard', 'https://abc123.trycloudflare.com/dashboard'],
    ]);
    const result = rewriteLocalUrls(
      'Open http://localhost:5173/dashboard',
      urlMap
    );
    expect(result).toContain('`localhost:5173/dashboard` （ <https://abc123.trycloudflare.com/dashboard|Slackからはこちら> ）');
  });
});
