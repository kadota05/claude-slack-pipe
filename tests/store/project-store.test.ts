import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// Import after mock
import { ProjectStore } from '../../src/store/project-store.js';

describe('ProjectStore', () => {
  const baseDir = '/home/user/.claude/projects';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should list projects from the projects directory', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === baseDir) {
        return [
          { name: 'project-a', isDirectory: () => true, isFile: () => false },
          { name: 'project-b', isDirectory: () => true, isFile: () => false },
          { name: 'some-file.txt', isDirectory: () => false, isFile: () => true },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockedFs.statSync.mockReturnValue({
      mtimeMs: Date.now(),
    } as fs.Stats);

    const store = new ProjectStore(baseDir);
    const projects = store.getProjects();

    expect(projects).toHaveLength(2);
    expect(projects[0].id).toBe('project-a');
    expect(projects[1].id).toBe('project-b');
  });

  it('should return cached results within TTL', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === baseDir) {
        return [
          { name: 'proj', isDirectory: () => true, isFile: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const store = new ProjectStore(baseDir);
    store.getProjects();
    store.getProjects();

    // readdirSync for baseDir should only be called once (cached)
    const baseDirCalls = mockedFs.readdirSync.mock.calls.filter(
      (call) => call[0].toString() === baseDir,
    );
    expect(baseDirCalls).toHaveLength(1);
  });

  it('should refresh cache after TTL expiry', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === baseDir) {
        return [
          { name: 'proj', isDirectory: () => true, isFile: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const store = new ProjectStore(baseDir, 30_000);
    store.getProjects();

    // Advance past TTL
    vi.advanceTimersByTime(31_000);

    store.getProjects();

    const baseDirCalls = mockedFs.readdirSync.mock.calls.filter(
      (call) => call[0].toString() === baseDir,
    );
    expect(baseDirCalls).toHaveLength(2);
  });

  it('should return empty array when directory does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const store = new ProjectStore('/nonexistent/path');
    const projects = store.getProjects();

    expect(projects).toEqual([]);
  });

  it('should resolve project path from cwd field in JSONL', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === baseDir) {
        return [
          { name: '-Users-alice-code-myapp', isDirectory: () => true, isFile: () => false },
        ] as unknown as fs.Dirent[];
      }
      if (p === path.join(baseDir, '-Users-alice-code-myapp')) {
        return ['session1.jsonl', 'session2.jsonl'] as unknown as string[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const store = new ProjectStore(baseDir);
    const resolved = store.resolveProjectPath('/Users/alice/code/myapp');

    expect(resolved).toBe(path.join(baseDir, '-Users-alice-code-myapp'));
  });
});
