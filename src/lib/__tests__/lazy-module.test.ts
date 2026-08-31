import { describe, expect, it, vi } from 'vitest';
import { loadOnce } from '../lazy-module';

/**
 * `whenNear` опирается на `IntersectionObserver`/`window` — это браузерная
 * механика, проверяется только вручную/в браузере. Здесь — только чистая
 * логика мемоизации `loadOnce` (см. doc-comment в lazy-module.ts).
 */
describe('loadOnce', () => {
  it('запускает loader один раз, повторные вызовы отдают тот же промис', async () => {
    const loader = vi.fn(async () => ({ value: 42 }));
    const load = loadOnce(loader);

    const first = load();
    const second = load();

    expect(first).toBe(second); // конкурентные вызовы делят один промис
    await expect(first).resolves.toEqual({ value: 42 });
    await expect(load()).resolves.toEqual({ value: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('после реджекта следующий вызов пробует загрузиться заново', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('ok');
    const load = loadOnce(loader);

    await expect(load()).rejects.toThrow('network');
    await expect(load()).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
