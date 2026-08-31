/**
 * Конфиг медиа-конвейера — ЕДИНСТВЕННЫЙ файл, который проект правит под себя.
 * Сами скрипты (`build-media-index`, `apply-media`, `build-sorter-data`,
 * `build-review-sheets`, `queue-covers` / `import-covers`) проектных путей не
 * содержат. Полный рецепт: docs/recipes/photo-archive.md.
 *
 * КАРТИНА МИРА. Клиент присылает фото россыпью: папки «по моделям», выгрузку
 * старого сайта, кучу «вперемешку». Конвейер сводит всё в один индекс,
 * склеивает дубли по перцептивному хешу, раскладывает по товарам и слоям
 * (обложка / слайдер / галерея) и даёт клиенту /sortirovka/ — поправить руками
 * то, что автоматика не знает. Решения человека живут в assignments.json и
 * старше любой автоматики.
 */
import path from 'node:path';

/**
 * Корень, от которого считаются пути пулов и `id` кадров. По умолчанию —
 * корень самого проекта. Если сайт живёт в подпапке репозитория, а архивы
 * клиента лежат рядом (как на боевом проекте: `repo/website/` + `repo/Архив/`),
 * поднимите на уровень выше: `path.resolve(import.meta.dirname, '../..')`.
 * ВАЖНО: `id` кадров считаются от REPO_ROOT — после первого прогона менять
 * его нельзя, иначе assignments.json перестанет находить кадры.
 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Рабочая папка конвейера: индекс, разметка, решения человека, очереди. */
export const STAGING = path.join(REPO_ROOT, '.staging');

/**
 * ПУЛЫ — откуда берутся кадры. Каждый пул:
 *   name         имя (попадает в отчёты и sorter)
 *   dir          путь от REPO_ROOT
 *   attribution  как кадр узнаёт свой товар:
 *     'folders'  dir/<категория>/<slug>/файл — товар из пути (выгрузка сайта)
 *     'map'      dir/<папка>/файл + folderMap: {'папка клиента': 'cat/slug'}
 *     'none'     россыпь — товар назначает человек в /sortirovka/
 *   rank         кто «честнее» при прочих равных: 0 — авторская съёмка,
 *                дальше по убыванию качества источника. Влияет на порядок в
 *                галерее и на выбор победителя среди дублей.
 *
 * ЗАПОЛНИТЕ ПОД ПРОЕКТ. Пример из боевого проекта:
 *   { name: 'main',    dir: 'Лендинг клиента/главная', attribution: 'map',
 *     rank: 0, folderMap: { 'диван нова': 'sofa/divan-nova', … } },
 *   { name: 'archive', dir: 'Лендинг клиента/галерея', attribution: 'none', rank: 1 },
 *   { name: 'oldsite', dir: '.staging/oldsite-img',       attribution: 'folders', rank: 2 },
 */
export const POOLS = [
  // { name: 'shoot',   dir: 'client-photos/models', attribution: 'map', rank: 0, folderMap: {} },
  // { name: 'archive', dir: 'client-photos/misc',   attribution: 'none', rank: 1 },
];

/**
 * Расхождения имён «ключ пула → slug товара» ('cat/old-slug' → 'cat/new-slug').
 * Общие для apply-media И сортировщика — обязаны совпадать, иначе кадры на
 * сайте есть, а в сортировщике их не найти.
 */
export const PRODUCT_ALIASES = {};

/** Существительное категории для промптов генерации обложек. */
export const CATEGORY_NOUN = {
  // sofa: 'диван', bed: 'кровать',
};

/** Канон обложки: пропорция и размер img2img-генерации. */
export const COVER_W = 2000;
export const COVER_H = 1500;

/** Лимиты слоёв — держите в согласии с productSchema (slider.max/gallery.max). */
export const SLIDER_MAX = 20;
export const GALLERY_MAX = 30;

/** Потолок длинной стороны и качество при перекодировании в webp. */
export const OUTPUT_MAX = 1600;
export const OUTPUT_QUALITY = 82;

/**
 * Раздел «россыпь без разметки» (`prepare-gallery.mjs` → `build-collages.mjs`
 * → `merge-classification.mjs --set=archive`). Это ШАГ ДО индекса: сырые
 * файлы архива клиента ещё не читаются браузером (HEIC/MOV) и не привязаны к
 * товару — сначала их конвертируют в webp-превью, потом человек размечает
 * контактными листами. Когда разметка готова, добавьте `.staging/gallery/full`
 * как обычный пул в POOLS (attribution: 'none') — он присоединится к общему
 * pHash-дедупу. Подробности: docs/recipes/photo-archive.md.
 */
export const GALLERY_RAW_DIR = ''; // путь от REPO_ROOT, например 'Архив/фото россыпью'

/**
 * Папки внутри GALLERY_RAW_DIR, которые не должны попасть ни в превью, ни в
 * манифест: юридический риск, чужой контент, заведомый мусор. Одного имени
 * папки мало — `prepare-gallery.mjs` дополнительно считает md5 всего
 * исключённого и блокирует это содержимое, где бы оно ни встретилось (на
 * живом архиве те же файлы лежали ещё и в корне, вне исключённой папки).
 *
 * Пример: { name: 'стоковые рендеры', reason: 'водяной знак стокового банка, не работы клиента' }.
 */
export const GALLERY_EXCLUDED_FOLDERS = [];

/**
 * `build-media-collages.mjs`: ниже этой ширины кадр физически не может попасть
 * в слайдер (см. UI-порог карточки товара) — размечать такие кадры контактными
 * листами незачем, они всё равно уйдут в галерею. Держите в согласии с тем,
 * какая ширина слайдера реально используется на странице товара.
 */
export const SLIDER_MIN_FRAME_WIDTH = 1200;

/**
 * `merge-classification.mjs`: допустимые значения `category` в разметке архива.
 * Держите в согласии с `src/content/catalog/categories.json` плюс служебные
 * значения вроде 'interior' / 'other' для кадров, которые не станут карточкой
 * товара. Пустой список — валидатор отклонит любую категорию, пока вы не
 * заполните её под проект.
 */
export const CLASSIFICATION_CATEGORIES = [];
