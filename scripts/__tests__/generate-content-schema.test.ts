import { describe, it, expect } from 'vitest';
import { buildContentSchema, assertCategoryDepth } from '../generate-content-schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('buildContentSchema', () => {
  it('includes exactly the client-editable collections', () => {
    const doc = buildContentSchema();
    expect(Object.keys(doc.collections).sort()).toEqual(
      [
        'address',
        'categories',
        'faq',
        'features',
        'footer',
        'hero',
        'legal',
        'navigation',
        'pages',
        'pricing',
        'rating',
        'reviews',
        'sections',
        'showcase',
        'stats',
        'team',
        'partners',
        'timeline',
      ].sort(),
    );
  });

  it('converts each field to JSON Schema with its Russian description', () => {
    const doc = buildContentSchema();
    const features = doc.collections['features']!;
    expect(features.kind).toBe('array');
    expect(features.filePath).toBe('src/content/home/features.json');
    expect(features.itemSchema.properties.title).toMatchObject({
      type: 'string',
      description: 'Заголовок преимущества',
    });
  });

  it('marks rating as a singleton with its object key', () => {
    const doc = buildContentSchema();
    const rating = doc.collections['rating']!;
    expect(rating.kind).toBe('singleton');
    expect(rating.singletonKey).toBe('aggregate');
  });

  it('caps every string field and every array collection (audit H-4 defence in depth)', () => {
    const doc = buildContentSchema();

    const walk = (node: Record<string, any> | undefined, path: string, uncapped: string[]): void => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'string' && typeof node.maxLength !== 'number') uncapped.push(path);
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        walk(child as Record<string, any>, `${path}/${key}`, uncapped);
      }
      if (node.items) walk(node.items as Record<string, any>, `${path}/*`, uncapped);
      for (const branch of (node.anyOf ?? node.oneOf ?? []) as Record<string, any>[]) {
        walk(branch, path, uncapped);
      }
    };

    for (const [name, contract] of Object.entries(doc.collections)) {
      if (contract.kind === 'array') {
        expect(contract.maxItems, `${name} needs a maxItems in MAX_ITEMS`).toBeGreaterThan(0);
      }

      const uncapped: string[] = [];
      walk(contract.itemSchema, name, uncapped);

      expect(uncapped, 'string fields without maxLength').toEqual([]);
    }

    // Entries-коллекции (напр. products) — тот же класс дыры (H-4), но живут в
    // отдельном поле контракта; без этого блока новая entries-коллекция может
    // пройти ревью с незакапленным строковым полем, а этот тест этого не заметит.
    for (const [name, entry] of Object.entries(doc.entries ?? {})) {
      const uncapped: string[] = [];
      walk(entry.itemSchema, `entries/${name}`, uncapped);

      expect(uncapped, 'entries string fields without maxLength').toEqual([]);
    }
  });

  // §5.11: подпись поля в форме портала — это `description ?? <имя поля>`,
  // поэтому поле контракта без описания показывает клиенту сырой английский
  // ключ (`id`, `columns`, `heading`) посреди русского интерфейса. Это прямое
  // нарушение правила «ни одной английской строки на RU-сервере», и заметить
  // его глазами в 174-польном контракте нельзя — только замком.
  it('describes every field in Russian (portal renders `description ?? fieldName`)', () => {
    const doc = buildContentSchema();

    const walk = (node: Record<string, any> | undefined, path: string, bare: string[]): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const childPath = `${path}.${key}`;
        const def = child as Record<string, any>;
        if (typeof def?.description !== 'string' || def.description.trim() === '') {
          bare.push(childPath);
        }
        walk(def, childPath, bare);
      }
      if (node.items) walk(node.items as Record<string, any>, `${path}[]`, bare);
      for (const branch of (node.anyOf ?? node.oneOf ?? []) as Record<string, any>[]) {
        walk(branch, path, bare);
      }
    };

    const bare: string[] = [];
    for (const [name, contract] of Object.entries(doc.collections)) {
      walk(contract.itemSchema, name, bare);
    }
    for (const [name, entry] of Object.entries(doc.entries ?? {})) {
      walk(entry.itemSchema, `entries/${name}`, bare);
    }

    expect(bare, 'поля без .describe() — портал покажет их английский ключ').toEqual([]);
  });

  it('объявляет папку и префикс для загрузок портала', () => {
    const doc = buildContentSchema();
    // Корень src/assets: пикер портала должен видеть и фото товаров, не
    // только загрузки CMS (урок боевого проекта, спека 2026-08-11).
    expect(doc.uploads).toEqual({ dir: 'src/assets', valuePrefix: '' });
  });

  it('matches the committed content.schema.json (run `npm run generate:content-schema` if this fails)', () => {
    const committedPath = resolve(import.meta.dirname, '../../content.schema.json');
    const committed = JSON.parse(readFileSync(committedPath, 'utf-8'));
    expect(buildContentSchema()).toEqual(committed);
  });

  it('emits the products entries collection and the categories array collection', () => {
    const doc = buildContentSchema();
    expect(doc.collections['categories']?.kind).toBe('array');
    const p = doc.entries?.['products'];
    expect(p).toMatchObject({
      label: 'Каталог товаров',
      dir: 'src/content/products',
      ext: '.md',
      routeBase: '/katalog',
      body: { enabled: true, format: 'markdown' },
    });
    expect(p!.itemSchema['properties']).toHaveProperty('title');
  });

  it('rejects a category whose parent is itself a child (depth > 2)', () => {
    expect(() =>
      assertCategoryDepth([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', parent: 'a' },
        { id: 'c', name: 'C', parent: 'b' },
      ]),
    ).toThrow(/глубина|parent/i);
  });

  it('rejects a category whose parent references a non-existent id', () => {
    expect(() =>
      assertCategoryDepth([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', parent: 'does-not-exist' },
      ]),
    ).toThrow(/не найден/i);
  });

  it('rejects a category whose parent is itself (self-reference), with a distinct message from the depth check', () => {
    expect(() =>
      assertCategoryDepth([{ id: 'a', name: 'A', parent: 'a' }]),
    ).toThrow(/сама на себя/i);
  });

  it('rejects duplicate category ids, naming every one', () => {
    expect(() =>
      assertCategoryDepth([
        { id: 'a', name: 'A one' },
        { id: 'a', name: 'A two' },
        { id: 'b', name: 'B' },
        { id: 'b', name: 'B again' },
      ]),
    ).toThrow(/a.*b|b.*a/i);
  });

  it('accepts categories with all-unique ids (no false positive)', () => {
    expect(() =>
      assertCategoryDepth([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', parent: 'a' },
      ]),
    ).not.toThrow();
  });

  // B3 (final review): z.toJSONSchema() marks every `.default(...)` field
  // required, which made the demo products — which rely on defaults for
  // gallery/features/brands/isHit/isNew/priority/draft rather than setting
  // them explicitly — fail ajv validation as "missing required field".
  it('strips defaulted fields out of required, but keeps genuinely required ones', () => {
    const doc = buildContentSchema();
    const products = doc.entries!['products']!.itemSchema;

    expect(products.required).toEqual(
      expect.arrayContaining(['title', 'category', 'shortDescription', 'image']),
    );
    for (const defaulted of ['gallery', 'features', 'brands', 'isHit', 'isNew', 'priority', 'draft']) {
      expect(products.required).not.toContain(defaulted);
      // Still present as a property — only removed from `required`, not dropped.
      expect(products.properties).toHaveProperty(defaulted);
    }

    const categories = doc.collections['categories']!.itemSchema;
    expect(categories.required).toEqual(expect.arrayContaining(['id', 'name']));
    expect(categories.required).not.toContain('priority');
  });
});
