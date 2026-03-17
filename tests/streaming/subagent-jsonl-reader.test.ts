// tests/streaming/subagent-jsonl-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubagentJsonlReader } from '../../src/streaming/subagent-jsonl-reader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SubagentJsonlReader', () => {
  let tmpDir: string;
  let reader: SubagentJsonlReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-test-'));
    reader = new SubagentJsonlReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(projectPath: string, sessionId: string, agentId: string, lines: any[]): void {
    const dirName = projectPath.replace(/\//g, '-');
    const dir = path.join(tmpDir, dirName, sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
  }

  it('reads subagent JSONL and extracts conversation flow', async () => {
    writeFixture('/Users/test/project', 'session-123', 'abc123', [
      { type: 'user', message: { role: 'user', content: 'You are a search agent. Find auth code.' }, timestamp: '2026-03-16T10:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will search for auth code.' }] }, timestamp: '2026-03-16T10:00:01.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Grep', input: { pattern: 'auth' } }] }, timestamp: '2026-03-16T10:00:02.000Z' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'found 5 matches' }] }, timestamp: '2026-03-16T10:00:03.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found auth code in 5 files.' }] }, timestamp: '2026-03-16T10:00:04.000Z' },
    ]);

    const flow = await reader.read('/Users/test/project', 'session-123', 'abc123');
    expect(flow).not.toBeNull();
    expect(flow!.systemPromptSummary.length).toBeGreaterThan(0);
    expect(flow!.systemPromptSummary.length).toBeLessThanOrEqual(200);
    expect(flow!.steps.length).toBeGreaterThan(0);
    expect(flow!.finalResult).toContain('Found auth');
    expect(flow!.totalDurationMs).toBe(4000);
  });

  it('returns null when file does not exist', async () => {
    const flow = await reader.read('/nonexistent', 'session-x', 'agent-x');
    expect(flow).toBeNull();
  });

  it('correctly converts project path to directory name', () => {
    const dirName = (reader as any).toProjectDirName('/Users/archeco055/dev/claude-slack-pipe');
    expect(dirName).toBe('-Users-archeco055-dev-claude-slack-pipe');
  });

  it('handles malformed JSONL lines gracefully', async () => {
    const dirName = '/Users/test/project'.replace(/\//g, '-');
    const dir = path.join(tmpDir, dirName, 'session-bad', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'agent-bad123.jsonl');
    fs.writeFileSync(filePath, 'invalid json\n{"type":"user","message":{"role":"user","content":"Hello"}}\n');

    const flow = await reader.read('/Users/test/project', 'session-bad', 'bad123');
    expect(flow).not.toBeNull();
  });
});
