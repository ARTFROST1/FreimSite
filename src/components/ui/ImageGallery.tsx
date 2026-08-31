import { useEffect, useState, useCallback } from 'react';

/**
 * Image gallery with a lightbox — React island (hydrate with client:visible).
 * Zero external deps: grid + full-screen viewer, keyboard (←/→/Esc) + click
 * navigation. Pass images as [{ src, alt }].
 */

/**
 * Клиентский остров не может обращаться к astro:assets (оптимизация живёт на
 * сборке, в Node), поэтому страница передаёт СЮДА уже готовые адреса: `src` +
 * `srcSet` для сетки и `full` для лайтбокса.
 */
export interface GalleryImage {
  src: string;
  /** srcset сетки — приходит из getImage на стороне страницы. */
  srcSet?: string;
  /** sizes для srcSet выше: без него браузер считает плитку за 100vw и тянет
   *  самый широкий кандидат туда, где реально нужна четверть/половина экрана. */
  sizes?: string;
  /** Широкий вариант для лайтбокса; по умолчанию равен `src`. */
  full?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export default function ImageGallery({ images }: { images: GalleryImage[] }) {
  const [open, setOpen] = useState<number | null>(null);

  const close = useCallback(() => setOpen(null), []);
  const prev = useCallback(
    () => setOpen((i) => (i === null ? i : (i - 1 + images.length) % images.length)),
    [images.length],
  );
  const next = useCallback(
    () => setOpen((i) => (i === null ? i : (i + 1) % images.length)),
    [images.length],
  );

  useEffect(() => {
    if (open === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, close, prev, next]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {images.map((img, i) => (
          <button
            key={i}
            onClick={() => setOpen(i)}
            className="group aspect-square overflow-hidden rounded-lg border border-line"
            aria-label={`Открыть изображение ${i + 1}`}
          >
            <img
              src={img.src}
              srcSet={img.srcSet}
              sizes={img.sizes}
              width={img.width}
              height={img.height}
              alt={img.alt ?? `Фото ${i + 1}`}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          </button>
        ))}
      </div>

      {open !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
          onClick={close}
          role="dialog"
          aria-modal="true"
        >
          <button className="absolute right-4 top-4 text-3xl text-white/80 hover:text-white" onClick={close} aria-label="Закрыть">
            ×
          </button>
          <button
            className="absolute left-4 text-4xl text-white/80 hover:text-white"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Предыдущее"
          >
            ‹
          </button>
          <img
            src={images[open].full ?? images[open].src}
            alt={images[open].alt ?? ''}
            className="max-h-[85vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute right-4 text-4xl text-white/80 hover:text-white"
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Следующее"
          >
            ›
          </button>
          <div className="absolute bottom-4 text-sm text-white/70">
            {open + 1} / {images.length}
          </div>
        </div>
      )}
    </>
  );
}
