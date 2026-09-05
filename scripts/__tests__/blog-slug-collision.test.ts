import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** foo.md + foo.mdx → один id коллекции Astro → сборка падает. Ловим раньше. */
export function duplicateBaseNames(files: string[]): string[] {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const f of files) {
    const m = f.match(/^(.*)\.(md|mdx)$/);
    if (!m) continue;
    const prev = seen.get(m[1]);
    if (prev && prev !== f) dupes.push(m[1]);
    seen.set(m[1], f);
  }
  return dupes;
}

describe('блог: слаг не может жить в .md и .mdx одновременно', () => {
  it('находит дубль базового имени', () => {
    expect(duplicateBaseNames(['a.md', 'a.mdx', 'b.md'])).toEqual(['a']);
    expect(duplicateBaseNames(['a.md', 'b.mdx'])).toEqual([]);
  });

  it('в src/content/blog/ дублей нет (замок; создал .mdx — проверь слаг)', () => {
    expect(duplicateBaseNames(readdirSync('src/content/blog'))).toEqual([]);
  });
});
