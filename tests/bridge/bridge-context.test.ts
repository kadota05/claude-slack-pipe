import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/bridge/bridge-context.js';

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
