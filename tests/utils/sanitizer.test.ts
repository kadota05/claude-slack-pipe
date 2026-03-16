import { describe, it, expect } from 'vitest';
import { sanitizeUserInput, sanitizeOutput } from '../../src/utils/sanitizer.js';

describe('sanitizeUserInput', () => {
  it('should replace user mentions with @user format', () => {
    expect(sanitizeUserInput('Hello <@U12345>')).toBe('Hello @U12345');
  });

  it('should replace channel references with #channel format', () => {
    expect(sanitizeUserInput('See <#C12345|general>')).toBe('See #general');
  });

  it('should replace channel references without label', () => {
    expect(sanitizeUserInput('See <#C12345>')).toBe('See #C12345');
  });

  it('should replace URL links with label', () => {
    expect(sanitizeUserInput('Visit <https://example.com|Example>')).toBe(
      'Visit Example (https://example.com)',
    );
  });

  it('should replace URL links without label', () => {
    expect(sanitizeUserInput('Visit <https://example.com>')).toBe(
      'Visit https://example.com',
    );
  });

  it('should handle multiple replacements in one message', () => {
    const input = 'Hey <@U111> check <#C222|dev> and <https://x.com|link>';
    const expected = 'Hey @U111 check #dev and link (https://x.com)';
    expect(sanitizeUserInput(input)).toBe(expected);
  });
});

describe('sanitizeOutput', () => {
  it('should redact OpenAI-style API keys (sk-...)', () => {
    expect(sanitizeOutput('key: sk-abc123def456ghi789')).toBe(
      'key: [REDACTED_API_KEY]',
    );
  });

  it('should redact Slack bot tokens (xoxb-...)', () => {
    expect(sanitizeOutput('token: xoxb-123-456-abc')).toBe(
      'token: [REDACTED_SLACK_TOKEN]',
    );
  });

  it('should redact Slack app tokens (xapp-...)', () => {
    expect(sanitizeOutput('app: xapp-1-A123-456-abc')).toBe(
      'app: [REDACTED_SLACK_TOKEN]',
    );
  });

  it('should redact Slack user tokens (xoxp-...)', () => {
    expect(sanitizeOutput('user: xoxp-123-456-789-abc')).toBe(
      'user: [REDACTED_SLACK_TOKEN]',
    );
  });

  it('should handle multiple secrets in one message', () => {
    const input = 'bot: xoxb-aaa-bbb key: sk-secret123';
    const expected = 'bot: [REDACTED_SLACK_TOKEN] key: [REDACTED_API_KEY]';
    expect(sanitizeOutput(input)).toBe(expected);
  });

  it('should leave normal text unchanged', () => {
    const input = 'This is a normal message with no secrets.';
    expect(sanitizeOutput(input)).toBe(input);
  });
});
