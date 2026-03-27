import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/slack/file-processor.js', () => ({
  downloadFile: vi.fn(),
}));

import { downloadFilesToTemp } from '../../src/bridge/file-downloader.js';
import { downloadFile } from '../../src/slack/file-processor.js';

const mockedDownload = vi.mocked(downloadFile);

describe('downloadFilesToTemp', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-dl-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('downloads files and returns temp paths', async () => {
    const files = [
      { id: 'F1', name: 'photo.jpg', mimetype: 'image/jpeg', size: 100, url_private_download: 'https://files.slack.com/photo.jpg' },
    ];
    mockedDownload.mockResolvedValue(Buffer.from('fake-image-data'));

    const result = await downloadFilesToTemp(files, 'xoxb-token', tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/photo\.jpg$/);
    const content = await fs.readFile(result[0]);
    expect(content.toString()).toBe('fake-image-data');
    expect(mockedDownload).toHaveBeenCalledWith('https://files.slack.com/photo.jpg', 'xoxb-token');
  });

  it('returns empty array when no files', async () => {
    const result = await downloadFilesToTemp([], 'xoxb-token', tempDir);
    expect(result).toEqual([]);
  });

  it('skips files without download URL', async () => {
    const files = [
      { id: 'F1', name: 'no-url.jpg', mimetype: 'image/jpeg', size: 100 },
    ];
    const result = await downloadFilesToTemp(files as any, 'xoxb-token', tempDir);
    expect(result).toEqual([]);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('skips files that fail to download', async () => {
    const files = [
      { id: 'F1', name: 'fail.jpg', mimetype: 'image/jpeg', size: 100, url_private_download: 'https://example.com/fail' },
    ];
    mockedDownload.mockRejectedValue(new Error('download failed'));
    const result = await downloadFilesToTemp(files, 'xoxb-token', tempDir);
    expect(result).toEqual([]);
  });
});
