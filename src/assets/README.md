# `src/assets` — картинки, которые оптимизирует Astro

Всё в этой папке проходит через `astro:assets`: ресайз, webp/avif, `srcset`,
`width/height`, хеш в имени. Доступ — только через `src/lib/images/registry.ts`
(`asset` / `assetsIn` / `coverIn`), напрямую импортировать файлы не нужно.

## Папки

| Папка | Что |
| --- | --- |
| `cms/` | загрузки клиента через CMS-портал (`<uuid>.<ext>`) — **руками не трогать** |
| `hero/` | фоны первого экрана |
| `sections/` | картинки секций (`IntroSection` и т.п.) |
| `gallery/` | галерея страницы `/gallery/` — «положил файл → появился» |
| `showcase/` | слайды `StackedShowcase`, если их кладёт разработчик, а не клиент |
| `blog/` | обложки и картинки статей |

## Что остаётся в `public/` и почему

`og/*` (соцсети требуют стабильный URL и точные 1200×630), `favicon.svg`,
`apple-touch-icon.png`, `site.webmanifest`, `robots.txt`, `fonts/*`,
`fd-edit.js`, `images/placeholder.svg` (фолбэк, на который ссылаются дефолты
пропсов и легаси-контент). Правило: **нужен стабильный внешний URL → `public/`,
иначе → `src/assets/`.**
