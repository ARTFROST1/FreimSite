import { describe, it, expect, vi } from 'vitest';
import type { ImageMetadata } from 'astro';
import { assetKeyFor, resolveImageValue, classifyImageSource, IMAGE_FALLBACK_URL } from '../resolve';

const img = (src: string): ImageMetadata =>
  ({ src, width: 1200, height: 800, format: 'webp' }) as ImageMetadata;

const svgImg = (src: string): ImageMetadata =>
  ({ src, width: 64, height: 64, format: 'svg' }) as ImageMetadata;

describe('assetKeyFor', () => {
  it('возвращает ключ как есть для значения без ведущего слэша', () => {
    expect(assetKeyFor('cms/a.png')).toBe('cms/a.png');
    expect(assetKeyFor('blog/cover.webp')).toBe('blog/cover.webp');
  });

  it('переводит легаси-путь /images/cms/x в ключ cms/x', () => {
    expect(assetKeyFor('/images/cms/a.png')).toBe('cms/a.png');
  });

  it('не считает ключом любой другой абсолютный путь или внешний URL', () => {
    expect(assetKeyFor('/images/placeholder.svg')).toBeNull();
    expect(assetKeyFor('/og/og-home.jpg')).toBeNull();
    expect(assetKeyFor('https://cdn.example/x.png')).toBeNull();
    expect(assetKeyFor('')).toBeNull();
  });

  it('не пропускает выход за пределы src/assets', () => {
    expect(assetKeyFor('../secrets/x.png')).toBeNull();
    expect(assetKeyFor('cms/../../x.png')).toBeNull();
  });
});

describe('resolveImageValue', () => {
  const registry = new Map([['cms/a.png', img('/_astro/a.hash.webp')]]);
  const lookup = (key: string) => registry.get(key);

  it('ключ есть в реестре → ImageMetadata', () => {
    expect(resolveImageValue('cms/a.png', lookup)).toEqual({
      kind: 'asset',
      img: registry.get('cms/a.png'),
    });
  });

  it('легаси-путь тоже находит файл, уже переехавший в src/assets', () => {
    expect(resolveImageValue('/images/cms/a.png', lookup)).toEqual({
      kind: 'asset',
      img: registry.get('cms/a.png'),
    });
  });

  it('легаси-путь без файла в реестре отдаётся как публичный URL', () => {
    expect(resolveImageValue('/images/cms/old.png', lookup)).toEqual({
      kind: 'url',
      url: '/images/cms/old.png',
    });
  });

  it('публичный путь отдаётся как URL без обращения к реестру', () => {
    expect(resolveImageValue('/images/placeholder.svg', lookup)).toEqual({
      kind: 'url',
      url: '/images/placeholder.svg',
    });
  });

  it('ключ-промах не роняет сборку, а даёт фолбэк', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveImageValue('cms/missing.png', lookup)).toEqual({
        kind: 'url',
        url: IMAGE_FALLBACK_URL,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('cms/missing.png'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('classifyImageSource', () => {
  const rasterMeta = img('/_astro/a.hash.webp');
  const svgMeta = svgImg('/_astro/logo.hash.svg');
  const registry = new Map([
    ['cms/a.png', rasterMeta],
    ['icons/logo.svg', svgMeta],
  ]);
  const lookup = (key: string) => registry.get(key);

  it('ImageMetadata-растр на входе → kind raster без обращения к lookup', () => {
    expect(classifyImageSource(rasterMeta, lookup)).toEqual({ kind: 'raster', img: rasterMeta });
  });

  it('ImageMetadata с format svg на входе → kind svg', () => {
    expect(classifyImageSource(svgMeta, lookup)).toEqual({ kind: 'svg', img: svgMeta });
  });

  it('строка-ключ реестра с растром → kind raster', () => {
    expect(classifyImageSource('cms/a.png', lookup)).toEqual({ kind: 'raster', img: rasterMeta });
  });

  it('строка-ключ реестра с svg → kind svg', () => {
    expect(classifyImageSource('icons/logo.svg', lookup)).toEqual({ kind: 'svg', img: svgMeta });
  });

  it('строка-публичный путь → kind url', () => {
    expect(classifyImageSource('/images/placeholder.svg', lookup)).toEqual({
      kind: 'url',
      url: '/images/placeholder.svg',
    });
  });

  it('строка-ключ без файла в реестре не роняет сборку, отдаёт url-фолбэк', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(classifyImageSource('cms/missing.png', lookup)).toEqual({
        kind: 'url',
        url: IMAGE_FALLBACK_URL,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
