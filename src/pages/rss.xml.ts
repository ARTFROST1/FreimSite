import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { SITE } from '../config/site';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  // date — строка `YYYY-MM-DD` (см. blogPostSchema), сортируется лексикографически.
  posts.sort((a, b) => b.data.date.localeCompare(a.data.date));

  return rss({
    title: `${SITE.name} — Блог`,
    description: SITE.description,
    site: context.site ?? SITE.url,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      // rss() ждёт Date — date у нас строка, поэтому оборачиваем.
      pubDate: new Date(post.data.date),
      link: `/blog/${post.id}/`,
    })),
    customData: `<language>${SITE.lang}</language>`,
  });
}
