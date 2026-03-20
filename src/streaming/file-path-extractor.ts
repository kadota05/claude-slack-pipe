import * as fs from 'node:fs';
import * as path from 'node:path';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.wasm', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function extractFilePaths(text: string, cwd: string): string[] {
  const textWithoutCodeBlocks = text.replace(/```[\s\S]*?```/g, '');

  const candidates = new Set<string>();

  const backtickRegex = /`([^`]+)`/g;
  for (const match of textWithoutCodeBlocks.matchAll(backtickRegex)) {
    const candidate = match[1];
    if (candidate.includes('/')) {
      candidates.add(candidate);
    }
  }

  const bareRegex = /(?:^|\s)((?:[\w@.-]+\/)+[\w.-]+)(?:\s|$|[,.:;)])/gm;
  for (const match of textWithoutCodeBlocks.matchAll(bareRegex)) {
    candidates.add(match[1]);
  }

  const results: string[] = [];
  // Use realpath to resolve symlinks (e.g. /var -> /private/var on macOS)
  const realCwd = fs.realpathSync(path.resolve(cwd));
  const normalizedCwd = realCwd + path.sep;

  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate);

    const ext = path.extname(resolved).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) continue;

      const realPath = fs.realpathSync(resolved);
      if (!realPath.startsWith(normalizedCwd)) continue;
    } catch {
      continue;
    }

    const relative = path.relative(cwd, resolved);
    if (!results.includes(relative)) {
      results.push(relative);
    }
  }

  return results;
}
