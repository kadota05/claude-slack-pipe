import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TunnelManager } from '../../src/streaming/tunnel-manager.js';

// Mock child_process.spawn
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  function createMockProcess() {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 12345;
    return proc;
  }

  return {
    spawn: vi.fn(() => createMockProcess()),
  };
});

import { spawn } from 'child_process';

describe('TunnelManager', () => {
  let manager: TunnelManager;

  beforeEach(() => {
    manager = new TunnelManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.stopAll();
  });

  it('returns undefined for unknown port', () => {
    expect(manager.getTunnelUrl(3000)).toBeUndefined();
  });

  it('starts cloudflared with correct arguments', () => {
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'localhost:3000'],
      expect.any(Object)
    );
  });

  it('does not start duplicate tunnel for same port', () => {
    manager.startTunnel(3000);
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('parses tunnel URL from stderr', async () => {
    const promise = manager.startTunnel(3000);
    const mockProc = (spawn as any).mock.results[0].value;

    // Simulate cloudflared stderr output
    mockProc.stderr.emit(
      'data',
      Buffer.from('2026-03-19T00:00:00Z INF |  https://test-tunnel.trycloudflare.com')
    );

    const url = await promise;
    expect(url).toBe('https://test-tunnel.trycloudflare.com');
    expect(manager.getTunnelUrl(3000)).toBe('https://test-tunnel.trycloudflare.com');
  });

  it('stopAll kills all processes', async () => {
    manager.startTunnel(3000);
    manager.startTunnel(8080);
    const proc1 = (spawn as any).mock.results[0].value;
    const proc2 = (spawn as any).mock.results[1].value;

    manager.stopAll();
    expect(proc1.kill).toHaveBeenCalled();
    expect(proc2.kill).toHaveBeenCalled();
  });
});
