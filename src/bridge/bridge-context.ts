import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const ARG_MAX_SAFE = 200_000;

export interface SkillMeta {
  name: string;
  description: string;
}

export function parseFrontmatter(content: string): SkillMeta | null {
  if (!content.startsWith('---')) return null;

  const secondDelimiter = content.indexOf('\n---', 3);
  if (secondDelimiter === -1) return null;

  const yaml = content.slice(4, secondDelimiter);

  const nameMatch = yaml.match(/^name:\s*(['"]?)(.+?)\1\s*$/m);
  const descMatch = yaml.match(/^description:\s*(['"]?)(.+?)\1\s*$/m);

  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[2],
    description: descMatch[2],
  };
}

export async function buildBridgeContext(dataDir: string): Promise<string> {
  const parts: string[] = [];

  const claudeMdPath = path.join(dataDir, 'CLAUDE.md');
  try {
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    parts.push(content.trim());
  } catch {
    // CLAUDE.md doesn't exist or unreadable — skip
  }

  const skillsDir = path.join(dataDir, 'skills');
  try {
    const files = await fs.readdir(skillsDir);
    const skills: SkillMeta[] = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(skillsDir, file), 'utf-8');
        const meta = parseFrontmatter(content);
        if (meta) {
          skills.push(meta);
        }
      } catch {
        logger.warn(`Failed to read skill file: ${file}`);
      }
    }

    if (skills.length > 0) {
      const skillsList = skills
        .map(s => `- ${s.name}: ${s.description}`)
        .join('\n');
      parts.push(`[Bridge Skills]\nThe following bridge skills are available for use with the Skill tool:\n\n${skillsList}`);
    }
  } catch {
    // skills directory doesn't exist or unreadable — skip
  }

  const result = parts.join('\n\n');

  if (result.length > ARG_MAX_SAFE) {
    logger.warn(`Bridge context exceeds safe ARG_MAX limit (${result.length} bytes), skipping injection`);
    return '';
  }

  return result;
}
