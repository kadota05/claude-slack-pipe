// tests/slack/command-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/slack/command-parser.js';

describe('parseCommand (phase2)', () => {
  describe('bot_command', () => {
    it('recognizes cc /end', () => {
      const result = parseCommand('cc /end');
      expect(result).toEqual({ type: 'bot_command', command: 'end', args: '' });
    });

    it('recognizes cc /status', () => {
      const result = parseCommand('cc /status');
      expect(result).toEqual({ type: 'bot_command', command: 'status', args: '' });
    });

    it('recognizes cc /restart', () => {
      const result = parseCommand('cc /restart');
      expect(result).toEqual({ type: 'bot_command', command: 'restart', args: '' });
    });

    it('recognizes cc /cli-status as cc /status alias', () => {
      const result = parseCommand('cc /cli-status');
      expect(result).toEqual({ type: 'bot_command', command: 'status', args: '' });
    });
  });

  describe('passthrough', () => {
    it('passes /compact through', () => {
      const result = parseCommand('/compact');
      expect(result).toEqual({ type: 'passthrough', content: '/compact' });
    });

    it('passes cc /compact through (strips cc prefix)', () => {
      const result = parseCommand('cc /compact');
      expect(result).toEqual({ type: 'passthrough', content: '/compact' });
    });

    it('passes /model opus through', () => {
      const result = parseCommand('/model opus');
      expect(result).toEqual({ type: 'passthrough', content: '/model opus' });
    });

    it('passes cc /commit through', () => {
      const result = parseCommand('cc /commit');
      expect(result).toEqual({ type: 'passthrough', content: '/commit' });
    });

    it('passes /help through', () => {
      const result = parseCommand('/help');
      expect(result).toEqual({ type: 'passthrough', content: '/help' });
    });

    it('passes /diff through', () => {
      const result = parseCommand('cc /diff');
      expect(result).toEqual({ type: 'passthrough', content: '/diff' });
    });
  });

  describe('plain_text', () => {
    it('classifies normal text', () => {
      const result = parseCommand('Fix the auth bug');
      expect(result).toEqual({ type: 'plain_text', content: 'Fix the auth bug' });
    });

    it('classifies empty string', () => {
      const result = parseCommand('');
      expect(result).toEqual({ type: 'plain_text', content: '' });
    });
  });
});
