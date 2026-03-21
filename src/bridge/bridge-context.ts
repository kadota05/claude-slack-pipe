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
