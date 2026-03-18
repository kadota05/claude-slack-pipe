// tests/streaming/localhost-rewriter.test.ts
import { describe, it, expect } from 'vitest';
import { isPrivateIp } from '../../src/streaming/localhost-rewriter.js';

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
