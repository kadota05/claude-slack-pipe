import { describe, it, expect, beforeEach, vi } from 'vitest';

// Prevent dotenv from injecting .env file values during tests
vi.mock('dotenv', () => ({ default: { config: () => {} }, config: () => {} }));

describe('config', () => {
  const requiredEnv = {
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  };

  beforeEach(() => {
    vi.resetModules();
    // Clear all env vars that config reads
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.ALLOWED_USER_IDS;
    delete process.env.ALLOWED_TEAM_IDS;
    delete process.env.ADMIN_USER_IDS;
    delete process.env.CLAUDE_EXECUTABLE;
    delete process.env.CLAUDE_PROJECTS_DIR;
    delete process.env.MAX_CONCURRENT_PER_USER;
    delete process.env.MAX_CONCURRENT_GLOBAL;
    delete process.env.DEFAULT_TIMEOUT_MS;
    delete process.env.MAX_TIMEOUT_MS;
    delete process.env.LOG_LEVEL;
    delete process.env.DATA_DIR;
    delete process.env.AUTO_UPDATE_ENABLED;
    delete process.env.AUTO_UPDATE_INTERVAL_MS;
  });

  it('should load config from env vars', async () => {
    Object.assign(process.env, {
      ...requiredEnv,
      ALLOWED_USER_IDS: 'U111,U222',
      ALLOWED_TEAM_IDS: 'T111',
      ADMIN_USER_IDS: 'U111',
      LOG_LEVEL: 'debug',
    });

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slackBotToken).toBe('xoxb-test-token');
    expect(config.slackAppToken).toBe('xapp-test-token');
    expect(config.allowedUserIds).toEqual(['U111', 'U222']);
    expect(config.allowedTeamIds).toEqual(['T111']);
    expect(config.adminUserIds).toEqual(['U111']);
    expect(config.logLevel).toBe('debug');
  });

  it('should use defaults when optional vars are missing', async () => {
    Object.assign(process.env, requiredEnv);

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.claudeExecutable).toBe('claude');
    expect(config.claudeProjectsDir).toMatch(/\.claude\/projects$/);
    expect(config.maxConcurrentPerUser).toBe(1);
    expect(config.maxConcurrentGlobal).toBe(3);
    expect(config.defaultTimeoutMs).toBe(300000);
    expect(config.maxTimeoutMs).toBe(1800000);
    expect(config.logLevel).toBe('info');
  });

  it('should parse comma-separated IDs correctly', async () => {
    Object.assign(process.env, {
      ...requiredEnv,
      ALLOWED_USER_IDS: ' U111 , U222 , U333 ',
      ALLOWED_TEAM_IDS: '',
      ADMIN_USER_IDS: 'U111',
    });

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.allowedUserIds).toEqual(['U111', 'U222', 'U333']);
    expect(config.allowedTeamIds).toEqual([]);
  });

  it('should throw on missing required vars', async () => {
    // No SLACK_BOT_TOKEN or SLACK_APP_TOKEN set
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });

  it('sets default dataDir to ~/.claude-slack-pipe/', async () => {
    Object.assign(process.env, requiredEnv);

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.dataDir).toMatch(/\.claude-slack-pipe/);
  });

  it('reads DATA_DIR from env', async () => {
    Object.assign(process.env, requiredEnv);
    process.env.DATA_DIR = '/tmp/test-data';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.dataDir).toBe('/tmp/test-data');
  });

  it('should throw on missing SLACK_APP_TOKEN', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    // SLACK_APP_TOKEN missing

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });

  it('should include autoUpdateEnabled defaulting to true', async () => {
    delete process.env.AUTO_UPDATE_ENABLED;
    Object.assign(process.env, requiredEnv);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.autoUpdateEnabled).toBe(true);
  });

  it('should include autoUpdateIntervalMs defaulting to 1800000', async () => {
    delete process.env.AUTO_UPDATE_INTERVAL_MS;
    Object.assign(process.env, requiredEnv);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.autoUpdateIntervalMs).toBe(1800000);
  });
});
