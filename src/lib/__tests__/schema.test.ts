/**
 * Regression tests for two P0 structured-data fixes (see doc-comments in
 * ../schema.ts):
 *
 *   - `localBusinessSchema` must never emit `aggregateRating` — Google
 *     treats self-reported/borrowed ratings on Organization/LocalBusiness as
 *     a manual-action risk.
 *   - `productSchema` must always describe a price as `AggregateOffer` with
 *     `lowPrice` (never a bare `Offer`/`price`), and default `availability`
 *     to PreOrder (a made-to-order product isn't "in stock").
 */
import { describe, it, expect } from 'vitest';
import { localBusinessSchema, productSchema } from '../schema';

describe('localBusinessSchema', () => {
  it('never includes aggregateRating, even if the caller tries to pass one', () => {
    // @ts-expect-error — old (rating/reviewCount) shape is intentionally gone.
    const schema = localBusinessSchema({ rating: 4.9, reviewCount: 18 });
    expect(schema).not.toHaveProperty('aggregateRating');
    expect(JSON.stringify(schema)).not.toContain('aggregateRating');
  });

  it('accepts only an optional images list', () => {
    const schema = localBusinessSchema({ images: ['/images/a.webp'] });
    expect(schema.image).toEqual(['https://example.com/images/a.webp']);
    expect(schema).not.toHaveProperty('aggregateRating');
  });
});

describe('productSchema', () => {
  it('renders a single price as AggregateOffer.lowPrice, not a bare Offer', () => {
    const schema = productSchema({
      name: 'Товар',
      description: 'Описание',
      url: '/katalog/tovar/',
      image: '/images/tovar.webp',
      lowPrice: 12500,
    });
    const offers = schema.offers as Record<string, unknown>;
    expect(offers['@type']).toBe('AggregateOffer');
    expect(offers.lowPrice).toBe(12500);
    expect(offers).not.toHaveProperty('price');
  });

  it('defaults availability to PreOrder', () => {
    const schema = productSchema({
      name: 'Товар',
      description: 'Описание',
      url: '/katalog/tovar/',
      image: '/images/tovar.webp',
      lowPrice: 12500,
    });
    const offers = schema.offers as Record<string, unknown>;
    expect(offers.availability).toBe('https://schema.org/PreOrder');
  });

  it('lets the caller override availability (e.g. a project with real stock)', () => {
    const schema = productSchema({
      name: 'Товар',
      description: 'Описание',
      url: '/katalog/tovar/',
      image: '/images/tovar.webp',
      lowPrice: 12500,
      availability: 'https://schema.org/InStock',
    });
    const offers = schema.offers as Record<string, unknown>;
    expect(offers.availability).toBe('https://schema.org/InStock');
  });

  it('carries highPrice through when both bounds are given', () => {
    const schema = productSchema({
      name: 'Товар',
      description: 'Описание',
      url: '/katalog/tovar/',
      image: '/images/tovar.webp',
      lowPrice: 12500,
      highPrice: 25000,
    });
    const offers = schema.offers as Record<string, unknown>;
    expect(offers['@type']).toBe('AggregateOffer');
    expect(offers.lowPrice).toBe(12500);
    expect(offers.highPrice).toBe(25000);
  });

  it('omits offers entirely when no price is given', () => {
    const schema = productSchema({
      name: 'Товар',
      description: 'Описание',
      url: '/katalog/tovar/',
      image: '/images/tovar.webp',
    });
    expect(schema).not.toHaveProperty('offers');
  });
});
