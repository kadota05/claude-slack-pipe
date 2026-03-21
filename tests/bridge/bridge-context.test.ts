import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildBridgeContext, migrateTemplates, parseFrontmatter } from '../../src/bridge/bridge-context.js';

describe('parseFrontmatter', () => {
  it('parses unquoted name and description', () => {
    const content = `---
name: My Skill
description: Does something useful
---

Body content here`;
    expect(parseFrontmatter(content)).toEqual({
      name: 'My Skill',
      description: 'Does something useful',
    });
  });

  it('parses double-quoted values', () => {
    const content = `---
name: "Quoted Name"
description: "Quoted description"
---`;
    expect(parseFrontmatter(content)).toEqual({
      name: 'Quoted Name',
      description: 'Quoted description',
    });
  });

  it('parses single-quoted values', () => {
    const content = `---
name: 'Single Quoted'
description: 'Single desc'
---`;
    expect(parseFrontmatter(content)).toEqual({
      name: 'Single Quoted',
      description: 'Single desc',
    });
  });

  it('returns null if no frontmatter delimiters', () => {
    expect(parseFrontmatter('No frontmatter here')).toBeNull();
  });

  it('returns null if file does not start with ---', () => {
    expect(parseFrontmatter('text\n---\nname: X\n---')).toBeNull();
  });

  it('returns null if missing name', () => {
    const content = `---
description: Only desc
---`;
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null if missing description', () => {
    const content = `---
name: Only name
---`;
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null if only one --- delimiter', () => {
    const content = `---
name: Broken
description: No closing`;
    expect(parseFrontmatter(content)).toBeNull();
  });
});

describe('buildBridgeContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ctx-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no CLAUDE.md and no skills dir', async () => {
    const result = await buildBridgeContext(tmpDir);
    expect(result).toBe('');
  });

  it('returns CLAUDE.md content when only CLAUDE.md exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Bridge instructions here');
    const result = await buildBridgeContext(tmpDir);
    expect(result).toBe('Bridge instructions here');
  });

  it('returns CLAUDE.md + skills index when both exist', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Instructions');
    fs.mkdirSync(path.join(tmpDir, 'skills'));
    fs.writeFileSync(path.join(tmpDir, 'skills', 'test-skill.md'), `---
name: Test Skill
description: A test skill
---

Body`);
    const result = await buildBridgeContext(tmpDir);
    expect(result).toContain('Instructions');
    expect(result).toContain('[Bridge Skills]');
    expect(result).toContain('- Test Skill: A test skill');
  });

  it('returns only skills index when no CLAUDE.md', async () => {
    fs.mkdirSync(path.join(tmpDir, 'skills'));
    fs.writeFileSync(path.join(tmpDir, 'skills', 'a.md'), `---
name: Skill A
description: Desc A
---`);
    const result = await buildBridgeContext(tmpDir);
    expect(result).not.toContain('Instructions');
    expect(result).toContain('- Skill A: Desc A');
  });

  it('skips skill files with invalid frontmatter', async () => {
    fs.mkdirSync(path.join(tmpDir, 'skills'));
    fs.writeFileSync(path.join(tmpDir, 'skills', 'valid.md'), `---
name: Valid
description: Valid desc
---`);
    fs.writeFileSync(path.join(tmpDir, 'skills', 'invalid.md'), 'No frontmatter');
    const result = await buildBridgeContext(tmpDir);
    expect(result).toContain('- Valid: Valid desc');
    expect(result).not.toContain('invalid');
  });

  it('skips non-.md files in skills directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'skills'));
    fs.writeFileSync(path.join(tmpDir, 'skills', 'notes.txt'), 'not a skill');
    fs.writeFileSync(path.join(tmpDir, 'skills', 'real.md'), `---
name: Real
description: Real skill
---`);
    const result = await buildBridgeContext(tmpDir);
    expect(result).toContain('- Real: Real skill');
    expect(result).not.toContain('notes');
  });

  it('returns empty string when context exceeds ARG_MAX_SAFE', async () => {
    const hugeContent = 'x'.repeat(210_000);
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), hugeContent);
    const result = await buildBridgeContext(tmpDir);
    expect(result).toBe('');
  });
});

describe('migrateTemplates', () => {
  let tmpDataDir: string;
  let tmpTemplatesDir: string;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-data-'));
    tmpTemplatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tpl-'));
    fs.writeFileSync(path.join(tmpTemplatesDir, 'CLAUDE.md'), 'Default instructions');
    fs.mkdirSync(path.join(tmpTemplatesDir, 'skills'));
    fs.writeFileSync(path.join(tmpTemplatesDir, 'skills', 'skill-a.md'), 'Skill A content');
    fs.writeFileSync(path.join(tmpTemplatesDir, 'skills', 'skill-b.md'), 'Skill B content');
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpTemplatesDir, { recursive: true, force: true });
  });

  it('copies CLAUDE.md when it does not exist', async () => {
    await migrateTemplates(tmpDataDir, tmpTemplatesDir);
    const content = fs.readFileSync(path.join(tmpDataDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('Default instructions');
  });

  it('does not overwrite existing CLAUDE.md', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'CLAUDE.md'), 'User customized');
    await migrateTemplates(tmpDataDir, tmpTemplatesDir);
    const content = fs.readFileSync(path.join(tmpDataDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('User customized');
  });

  it('copies all skills when skills dir does not exist', async () => {
    await migrateTemplates(tmpDataDir, tmpTemplatesDir);
    const files = fs.readdirSync(path.join(tmpDataDir, 'skills'));
    expect(files.sort()).toEqual(['skill-a.md', 'skill-b.md']);
  });

  it('copies only missing skills when skills dir partially exists', async () => {
    fs.mkdirSync(path.join(tmpDataDir, 'skills'));
    fs.writeFileSync(path.join(tmpDataDir, 'skills', 'skill-a.md'), 'Custom A');
    await migrateTemplates(tmpDataDir, tmpTemplatesDir);
    expect(fs.readFileSync(path.join(tmpDataDir, 'skills', 'skill-a.md'), 'utf-8')).toBe('Custom A');
    expect(fs.readFileSync(path.join(tmpDataDir, 'skills', 'skill-b.md'), 'utf-8')).toBe('Skill B content');
  });

  it('handles missing templates dir gracefully', async () => {
    await expect(migrateTemplates(tmpDataDir, '/nonexistent')).resolves.not.toThrow();
  });
});
