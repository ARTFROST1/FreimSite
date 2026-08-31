# Open Graph images

Social-share previews. **1200×630 px**, JP/PNG, < 300 KB.

Referenced from `src/config/seo.ts` (`ogImage`) and `src/config/site.ts`
(`ogImage` fallback). `og-default.jpg` ships as a neutral placeholder
(no text, no branding) so the fallback frame is never a broken image —
**replace it with your own** before launch. Per-page images
(`og-home.jpg`, `og-about.jpg`, …) improve click-through when links are shared.

Test rendering with the Facebook Sharing Debugger and Telegram's link preview
before launch.
