import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const configSchema = z.object({
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().min(1),
  allowedUserIds: z.array(z.string()),
  allowedTeamIds: z.array(z.string()),
  adminUserIds: z.array(z.string()),
  claudeExecutable: z.string().default('claude'),
  claudeProjectsDir: z.string(),
  dataDir: z.string(),
  maxConcurrentPerUser: z.number().int().positive(),
  maxConcurrentGlobal: z.number().int().positive(),
  defaultTimeoutMs: z.number().int().positive(),
  maxTimeoutMs: z.number().int().positive(),
  defaultBudgetUsd: z.number().positive(),
  maxBudgetUsd: z.number().positive(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const raw = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    allowedUserIds: parseCommaSeparated(process.env.ALLOWED_USER_IDS),
    allowedTeamIds: parseCommaSeparated(process.env.ALLOWED_TEAM_IDS),
    adminUserIds: parseCommaSeparated(process.env.ADMIN_USER_IDS),
    claudeExecutable: expandTilde(process.env.CLAUDE_EXECUTABLE || 'claude'),
    claudeProjectsDir: expandTilde(process.env.CLAUDE_PROJECTS_DIR || '~/.claude/projects'),
    dataDir: expandTilde(process.env.DATA_DIR || '~/.claude-slack-pipe/'),
    maxConcurrentPerUser: Number(process.env.MAX_CONCURRENT_PER_USER || '1'),
    maxConcurrentGlobal: Number(process.env.MAX_CONCURRENT_GLOBAL || '3'),
    defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || '300000'),
    maxTimeoutMs: Number(process.env.MAX_TIMEOUT_MS || '1800000'),
    defaultBudgetUsd: Number(process.env.DEFAULT_BUDGET_USD || '1.0'),
    maxBudgetUsd: Number(process.env.MAX_BUDGET_USD || '10.0'),
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) || 'info',
  };
  return configSchema.parse(raw);
}
