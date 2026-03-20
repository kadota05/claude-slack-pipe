import { describe, it, expect, beforeEach } from 'vitest';
import { extractFilePaths } from '../../src/streaming/file-path-extractor.js';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('extractFilePaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'file-path-test-'));
    mkdirSync(path.join(tempDir, 'src', 'streaming'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello")');
    writeFileSync(path.join(tempDir, 'src', 'streaming', 'processor.ts'), 'export {}');
    writeFileSync(path.join(tempDir, 'README.md'), '# README');
    writeFileSync(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50]));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts backtick-quoted paths that exist', () => {
    const text = 'Modified `src/index.ts` and `src/streaming/processor.ts`.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts', 'src/streaming/processor.ts']);
  });

  it('extracts bare slash-separated paths that exist', () => {
    const text = 'Changed src/index.ts to fix the bug.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('deduplicates paths found in both backtick and bare form', () => {
    const text = '`src/index.ts` was modified. See src/index.ts for details.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('excludes paths inside code blocks', () => {
    const text = 'Here is an example:\n```\nsrc/index.ts\n```\nDone.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes non-existent paths', () => {
    const text = '`src/nonexistent.ts` was changed.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes binary file extensions', () => {
    const text = 'Updated `image.png` as well.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes absolute paths outside cwd', () => {
    const text = 'Do not read `/etc/passwd`.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('allows absolute paths inside cwd', () => {
    const absPath = path.join(tempDir, 'src/index.ts');
    const text = `Modified \`${absPath}\`.`;
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('excludes files larger than 1MB', () => {
    const bigFile = path.join(tempDir, 'src', 'big.ts');
    writeFileSync(bigFile, 'x'.repeat(1024 * 1024 + 1));
    const text = '`src/big.ts` is large.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when no paths found', () => {
    const text = 'No file paths here at all.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('handles backtick content without slashes (not a path)', () => {
    const text = 'Run `npm install` to get started.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });
});
