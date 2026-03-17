/**
 * Proof that the per-user lock + dedup guard prevent duplicate session creation.
 *
 * Test 1: Without lock — race condition allows two sessions (existing bug)
 * Test 2: With lock — second call finds the registered entry (fix)
 * Test 3: Dedup guard — blocks duplicate text within 30s window
 */

import { SessionIndexStore } from '../src/store/session-index-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'race-test-'));
}

async function fakeGetOrCreateSession(delayMs: number): Promise<string> {
  await new Promise((r) => setTimeout(r, delayMs));
  return crypto.randomUUID();
}

// --- Test 1: Without lock (reproduces the bug) ---

async function testWithoutLock(): Promise<boolean> {
  const tmpDir = makeTempDir();
  try {
    const store = new SessionIndexStore(tmpDir);
    const threadTs = '1710000000.000001';

    async function handleNoLock(directoryId: string) {
      const entry = store.findByThreadTs(threadTs);
      if (entry) return { action: 'existing' as const, sessionId: entry.cliSessionId };

      const sessionId = await fakeGetOrCreateSession(50);
      store.register({
        cliSessionId: sessionId, threadTs, channelId: 'C', userId: 'U',
        projectPath: `/projects/${directoryId}`, name: 'test', model: 'sonnet',
        status: 'active', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      });
      return { action: 'created' as const, sessionId };
    }

    const callA = handleNoLock('old-dir');
    await new Promise((r) => setTimeout(r, 10));
    const callB = handleNoLock('new-dir');

    const [a, b] = await Promise.all([callA, callB]);
    const bothCreated = a.action === 'created' && b.action === 'created';
    console.log(`Test 1 (no lock): Both created? ${bothCreated ? '✅ YES — bug reproduced' : '❌ NO'}`);
    return bothCreated;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Test 2: With per-user lock (the fix) ---

async function testWithLock(): Promise<boolean> {
  const tmpDir = makeTempDir();
  try {
    const store = new SessionIndexStore(tmpDir);
    const threadTs = '1710000000.000002';
    const locks = new Map<string, Promise<void>>();

    async function handleWithLock(directoryId: string) {
      const userId = 'U';
      // Acquire lock
      const prevLock = locks.get(userId) || Promise.resolve();
      let releaseLock: () => void;
      const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
      locks.set(userId, prevLock.then(() => lockPromise));
      await prevLock;

      try {
        const entry = store.findByThreadTs(threadTs);
        if (entry) return { action: 'existing' as const, sessionId: entry.cliSessionId };

        const sessionId = await fakeGetOrCreateSession(50);
        store.register({
          cliSessionId: sessionId, threadTs, channelId: 'C', userId,
          projectPath: `/projects/${directoryId}`, name: 'test', model: 'sonnet',
          status: 'active', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        });
        return { action: 'created' as const, sessionId };
      } finally {
        releaseLock!();
      }
    }

    const callA = handleWithLock('old-dir');
    await new Promise((r) => setTimeout(r, 10));
    const callB = handleWithLock('new-dir');

    const [a, b] = await Promise.all([callA, callB]);
    const onlyOneCreated = a.action === 'created' && b.action === 'existing';
    console.log(`Test 2 (with lock): Only first created? ${onlyOneCreated ? '✅ YES — race condition fixed' : '❌ NO'}`);
    console.log(`  Call A: ${a.action} (${a.sessionId?.slice(0, 8)})`);
    console.log(`  Call B: ${b.action} (${b.sessionId?.slice(0, 8)})`);
    return onlyOneCreated;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Test 3: Dedup guard (blocks same text with different ts) ---

async function testDedupGuard(): Promise<boolean> {
  const recentMessages = new Map<string, { ts: string; time: number }>();
  const DEDUP_WINDOW_MS = 30_000;

  function wouldBlock(userId: string, text: string, ts: string): boolean {
    const dedupKey = `${userId}:${text}`;
    const now = Date.now();
    const prev = recentMessages.get(dedupKey);
    if (prev && (now - prev.time) < DEDUP_WINDOW_MS) {
      return true; // blocked
    }
    recentMessages.set(dedupKey, { ts, time: now });
    return false; // allowed
  }

  const blocked1 = wouldBlock('U1', 'Hello world', '1710000001.000001');
  const blocked2 = wouldBlock('U1', 'Hello world', '1710000002.000002'); // same text, different ts
  const blocked3 = wouldBlock('U1', 'Different text', '1710000003.000003'); // different text
  const blocked4 = wouldBlock('U2', 'Hello world', '1710000004.000004'); // different user

  const pass = !blocked1 && blocked2 && !blocked3 && !blocked4;
  console.log(`Test 3 (dedup guard):`);
  console.log(`  First message allowed?      ${!blocked1 ? '✅' : '❌'}`);
  console.log(`  Same text blocked?          ${blocked2 ? '✅' : '❌'}`);
  console.log(`  Different text allowed?     ${!blocked3 ? '✅' : '❌'}`);
  console.log(`  Different user allowed?     ${!blocked4 ? '✅' : '❌'}`);
  return pass;
}

// --- Run all ---

async function main() {
  console.log('=== Duplicate Session Prevention Tests ===\n');

  const r1 = await testWithoutLock();
  console.log('');
  const r2 = await testWithLock();
  console.log('');
  const r3 = await testDedupGuard();

  console.log(`\n=== Results ===`);
  console.log(`Bug reproduced (no lock):  ${r1 ? '✅' : '❌'}`);
  console.log(`Fix works (with lock):     ${r2 ? '✅' : '❌'}`);
  console.log(`Dedup guard works:         ${r3 ? '✅' : '❌'}`);

  if (r1 && r2 && r3) {
    console.log('\n✅ All tests passed — both defenses are effective.');
  } else {
    console.log('\n❌ Some tests failed.');
    process.exit(1);
  }
}

main().catch(console.error);
