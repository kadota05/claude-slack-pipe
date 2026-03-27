// src/slack/file-processor.ts
import { logger } from '../utils/logger.js';
import type { StdinContentBlock } from '../types.js';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

export interface FileProcessResult {
  contentBlocks: StdinContentBlock[];
  warnings: string[];
}

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const PDF_TYPE = 'application/pdf';

const TEXT_TYPES = new Set([
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
]);

function isTextType(mimetype: string): boolean {
  return TEXT_TYPES.has(mimetype) || mimetype.startsWith('text/');
}

type FileCategory = 'image' | 'pdf' | 'text' | 'unsupported';

function classifyFile(mimetype: string): FileCategory {
  if (IMAGE_TYPES.has(mimetype)) return 'image';
  if (mimetype === PDF_TYPE) return 'pdf';
  if (isTextType(mimetype)) return 'text';
  return 'unsupported';
}

const MAX_TOTAL_SIZE_BYTES = 32 * 1024 * 1024; // 32 MB

async function downloadFile(
  url: string,
  botToken: string,
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function processFiles(
  files: SlackFile[],
  botToken: string,
): Promise<FileProcessResult> {
  const contentBlocks: StdinContentBlock[] = [];
  const warnings: string[] = [];
  let totalBase64Bytes = 0;

  for (const file of files) {
    const category = classifyFile(file.mimetype);

    if (category === 'unsupported') {
      warnings.push(`${file.name} (${file.mimetype}) is not supported. Supported: images, PDF, text files.`);
      continue;
    }

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      warnings.push(`${file.name}: no download URL available.`);
      continue;
    }

    // Pre-check cumulative size before downloading
    if (category !== 'text') {
      totalBase64Bytes += file.size;
      if (totalBase64Bytes > MAX_TOTAL_SIZE_BYTES) {
        warnings.push(`Total file size exceeds 32MB limit. Skipping ${file.name} and remaining files.`);
        break;
      }
    }

    let buffer: Buffer;
    try {
      buffer = await downloadFile(downloadUrl, botToken);
    } catch (err) {
      logger.error(`Failed to download file ${file.name}`, { error: (err as Error).message });
      warnings.push(`${file.name}: download failed.`);
      continue;
    }

    if (category === 'text') {
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const text = decoder.decode(buffer);
        contentBlocks.push({ type: 'text', text: `${file.name}:\n${text}` });
      } catch {
        warnings.push(`${file.name}: could not decode as UTF-8 text.`);
      }
      continue;
    }

    // image or pdf — base64 encode
    const base64 = buffer.toString('base64');

    if (category === 'image') {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file.mimetype, data: base64 },
      });
    } else if (category === 'pdf') {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    }
  }

  return { contentBlocks, warnings };
}
