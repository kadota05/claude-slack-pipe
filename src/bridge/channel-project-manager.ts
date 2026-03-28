import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { discoverSkills } from './bridge-context.js';
import { logger } from '../utils/logger.js';

const SLACK_CONTEXT = `[Slack Bridge Context]
Accessed through Slack, not terminal.
- Assume the user is on a mobile phone
- Not at the machine — no local interaction possible
- Max 45 chars wide for tables/diagrams/ASCII art`;

export class ChannelProjectManager {
  private readonly channelsDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly templatesDir: string,
  ) {
    this.channelsDir = path.join(dataDir, 'channels');
  }

  getChannelsDir(): string {
    return this.channelsDir;
  }

  getProjectPath(channelId: string): string {
    return path.join(this.channelsDir, channelId);
  }

  exists(channelId: string): boolean {
    return fs.existsSync(this.getProjectPath(channelId));
  }

  listChannelIds(): string[] {
    try {
      return fs.readdirSync(this.channelsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  async init(channelId: string): Promise<string> {
    const projectPath = this.getProjectPath(channelId);

    await fsp.mkdir(path.join(projectPath, 'skills'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'mcps'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, '.claude'), { recursive: true });

    // Git init (Claude CLI requires a git repo as cwd)
    const gitDir = path.join(projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execSync('git init', { cwd: projectPath, stdio: 'ignore' });
        logger.info(`Git initialized for channel project: ${channelId}`);
      } catch (err) {
        logger.warn(`Failed to git init channel project: ${channelId}`, err);
      }
    }

    // CLAUDE.md from template (only if not exists)
    const claudeMdDest = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdDest)) {
      try {
        const content = await fsp.readFile(path.join(this.templatesDir, 'CLAUDE.md'), 'utf-8');
        await fsp.writeFile(claudeMdDest, content, 'utf-8');
      } catch {
        logger.warn('Channel template CLAUDE.md not found');
      }
    }

    // settings.json (only if not exists)
    const settingsPath = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      await fsp.writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }, null, 2), 'utf-8');
    }

    // schedule.json (only if not exists)
    const schedulePath = path.join(projectPath, 'schedule.json');
    if (!fs.existsSync(schedulePath)) {
      await fsp.writeFile(schedulePath, JSON.stringify({ triggers: [] }, null, 2), 'utf-8');
    }

    logger.info(`Initialized channel project: ${channelId}`);
    return projectPath;
  }

  async buildContext(channelId: string): Promise<string> {
    const projectPath = this.getProjectPath(channelId);
    const skills = await discoverSkills(path.join(projectPath, 'skills'));

    const parts = [SLACK_CONTEXT];
    if (skills.length > 0) {
      const skillsList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
      parts.push(`[Channel Skills]\nThe following skills are available for use with the Skill tool:\n\n${skillsList}`);
    }
    return parts.join('\n\n');
  }
}
