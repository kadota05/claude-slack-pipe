import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionJsonlReader } from '../../src/streaming/session-jsonl-reader.js';
import type { BundleEntry } from '../../src/streaming/session-jsonl-reader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SessionJsonlReader.readBundle', () => {
  let reader: SessionJsonlReader;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    reader = new SessionJsonlReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeJsonl(projectPath: string, sessionId: string, lines: any[]) {
    const dirName = projectPath.replace(/\//g, '-');
    const dir = path.join(tmpDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    fs.writeFileSync(filePath, content);
  }

  it('extracts bundle 0 (before first text)', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think...' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'file content' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the result' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('thinking');
    expect((entries[0] as any).texts).toEqual(['Let me think...']);
    expect(entries[1].type).toBe('tool');
    expect((entries[1] as any).toolName).toBe('Read');
  });

  it('extracts bundle 1 (between first and second long text)', async () => {
    // Use long texts (>= 100 chars) to ensure bundle boundaries are created
    const longText = 'This is a long response text that exceeds the hundred character threshold required to create a bundle boundary. Adding more text.';
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought1' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought2' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_002', name: 'Grep', input: { pattern: 'foo' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_002', content: '3 matches' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 1);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('thinking');
    expect(entries[1].type).toBe('tool');
    expect((entries[1] as any).toolName).toBe('Grep');
  });

  it('handles subagent (Agent tool_use) correctly', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore code' } }] } },
      { parent_tool_use_id: 'toolu_agent', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Read', input: { file_path: '/b.ts' } }] } },
      { parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'child result' }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('subagent');
    expect((entries[0] as any).description).toBe('explore code');
    expect((entries[0] as any).agentId).toBe('abc123');
  });

  it('merges consecutive thinking blocks into one entry', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'part1' }] } },
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'part2' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('thinking');
    expect((entries[0] as any).texts).toEqual(['part1', 'part2']);
  });

  it('returns empty for out-of-range bundleIndex', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 5);
    expect(entries).toHaveLength(0);
  });

  it('ignores user text blocks as bundle boundaries', async () => {
    writeJsonl('/test/project', 'sess-1', [
      // User message with text block — should NOT count as bundle boundary
      { message: { role: 'user', content: [{ type: 'text', text: 'Hello, please help' }] } },
      // Assistant thinking + tool
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me check' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'file content' }] } },
      // Assistant text — THIS is the bundle boundary
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the result' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(2); // thinking + tool
    expect(entries[0].type).toBe('thinking');
    expect(entries[1].type).toBe('tool');
  });

  it('skips child events with parentToolUseID (camelCase)', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore' } }] } },
      // Child event with camelCase parentToolUseID — should be skipped
      { parentToolUseID: 'toolu_agent', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Read', input: { file_path: '/b.ts' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(1); // Only subagent, child skipped
    expect(entries[0].type).toBe('subagent');
  });
});

describe('SessionJsonlReader bundle boundary', () => {
  it('should NOT create bundle boundary on short assistant text', async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const projectPath = '/test/project';
    const sessionId = 'sess-1';

    // Event flow:
    // thinking → tool_use(ToolSearch) → tool_result → short text → tool_use(mcp_tool) → tool_result → long text
    // Expected: ONE bundle containing thinking + ToolSearch + mcp_tool
    const dirName = projectPath.replace(/\//g, '-');
    const fullDir = path.join(tmpDir2, dirName);
    fs.mkdirSync(fullDir, { recursive: true });
    const filePath = path.join(fullDir, `${sessionId}.jsonl`);
    const lines = [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'searching...' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ts-1', name: 'ToolSearch', input: { query: 'mcp' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ts-1', content: 'found' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'ツールを確認。' }] } },  // short < 100
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__gcal', input: {} }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: 'events: []' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。Lorem ipsum dolor sit amet.' }] } },
    ];
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const reader2 = new SessionJsonlReader(tmpDir2);
    const entries = await reader2.readBundle(projectPath, sessionId, 0);

    // Bundle 0 should contain: thinking + ToolSearch + mcp_tool
    expect(entries.length).toBe(3);
    expect(entries[0].type).toBe('thinking');
    expect(entries[1].type).toBe('tool');
    expect(entries[2].type).toBe('tool');

    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('should create bundle boundary on long assistant text', async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const projectPath = '/test/project';
    const sessionId = 'sess-2';

    // Make sure the long text is genuinely >= 100 chars
    const longText = 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。Lorem ipsum dolor sit amet.';

    const dirName = projectPath.replace(/\//g, '-');
    const fullDir = path.join(tmpDir2, dirName);
    fs.mkdirSync(fullDir, { recursive: true });
    const filePath = path.join(fullDir, `${sessionId}.jsonl`);
    const lines = [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/tmp/f' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-2', name: 'Write', input: { file_path: '/tmp/f' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-2', content: 'ok' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ];
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const reader2 = new SessionJsonlReader(tmpDir2);
    const bundle0 = await reader2.readBundle(projectPath, sessionId, 0);
    const bundle1 = await reader2.readBundle(projectPath, sessionId, 1);

    // Bundle 0: Read tool only
    expect(bundle0.length).toBe(1);
    expect(bundle0[0].type).toBe('tool');

    // Bundle 1: Write tool only
    expect(bundle1.length).toBe(1);
    expect(bundle1[0].type).toBe('tool');

    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
