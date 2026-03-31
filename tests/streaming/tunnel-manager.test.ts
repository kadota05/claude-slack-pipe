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

  it('starts ssh tunnel with correct arguments', () => {
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ConnectTimeout=10',
        '-R', '80:localhost:3000',
        'nokey@localhost.run',
      ],
      expect.any(Object)
    );
  });

  it('does not start duplicate tunnel for same port', () => {
    manager.startTunnel(3000);
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('parses tunnel URL from stdout', async () => {
    const promise = manager.startTunnel(3000);
    const mockProc = (spawn as any).mock.results[0].value;

    // Simulate localhost.run stdout output
    mockProc.stdout.emit(
      'data',
      Buffer.from('1a65eac44b35b1.lhr.life tunneled with tls termination, https://1a65eac44b35b1.lhr.life')
    );

    const url = await promise;
    expect(url).toBe('https://1a65eac44b35b1.lhr.life');
    expect(manager.getTunnelUrl(3000)).toBe('https://1a65eac44b35b1.lhr.life');
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
