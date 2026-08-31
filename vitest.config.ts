// `getViteConfig`, not vitest's own `defineConfig`: the JSON-LD regression test
// imports `JsonLd.astro` and renders it through Astro's container API, and
// without Astro's Vite plugins an `import Foo from './Foo.astro'` has no
// transform at all, so the import fails.
//
// Do NOT wrap the object below in `defineConfig` from `vitest/config` and do
// NOT rely on `/// <reference types="vitest" />`: vitest resolves its own
// nested copy of Vite, so its `UserConfig` — and the `test` key it augments
// onto it — belong to a structurally different type from the `vite`
// `UserConfig` that `getViteConfig` accepts. Either route makes `astro check`
// fail (ts(2345) / ts(2353)). The augmentation below adds `test` to the Vite
// copy this project actually resolves, so the options stay type-checked.
import { getViteConfig } from 'astro/config';

declare module 'vite' {
  interface UserConfig {
    test?: import('vitest/node').InlineConfig;
  }
}

export default getViteConfig({
  test: {
    include: ['scripts/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
