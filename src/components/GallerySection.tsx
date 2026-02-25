import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

type GalleryFolder = {
  id: string;
  title: string;
  images: string[];
  cover: string;
};

const FOLDER_TITLES: Record<string, string> = {
  'APEX-Chasovaya-Moscow': 'APEX Chasovaya, Moscow',
  'APEX-Fonchenko-Moscow': 'APEX Fonchenko, Moscow',
  'APEX-Medical_complex-Moscow': 'APEX Medical Complex, Moscow',
  'APEX-Residential_Tolbuhino-Moscow': 'APEX Residential Tolbuhino, Moscow',
  'APEX-Residential_complex-Moscow': 'APEX Residential Complex, Moscow',
  'Apex-Apartments-Moscow': 'Apex Apartments, Moscow',
  'Ingrad_project-Residential_complex-Moscow': 'Ingrad Residential Complex, Moscow',
  'Sergey_Skuratov_Architects-Afi_Tower-Moscow': 'Afi Tower by Sergey Skuratov Architects',
  'Sergey_Skuratov_Architects-BRIKS_Hotel-Kazan': 'BRIKS Hotel, Kazan',
  'Sergey_Skuratov_Architects-Meteor-Moscow': 'Meteor, Moscow',
  'Sergey_Skuratov_Architects-Multifunctional_comlex-Moscow': 'Multifunctional Complex, Moscow',
  'Sergey_Skuratov_Architects-Rublevo_Archangelskoe-Moscow': 'Rublevo Archangelskoe, Moscow',
  'Sergey_Skuratov_Architects-Sadovye_kvartaly-Moscow': 'Sadovye Kvartaly, Moscow',
  'Sergey_Skuratov_Architects-Yar_Park-Kazan': 'Yar Park, Kazan',
};

const galleryModules = import.meta.glob<{ default: string }>(
  '../assets/vis_img/*/*.{jpg,jpeg,png,webp}',
  { eager: true }
);

const toTitle = (folder: string): string => {
  if (FOLDER_TITLES[folder]) {
    return FOLDER_TITLES[folder];
  }

  return folder.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
};

const galleryFolders: GalleryFolder[] = (
  Object.entries(galleryModules) as [string, { default: string }][]
)
  .reduce((acc, [path, mod]) => {
    const match = path.match(/\.\.\/assets\/vis_img\/([^/]+)\//);
    if (!match) return acc;

    const [, folder] = match;
    let target = acc.find((group) => group.id === folder);

    if (!target) {
      target = {
        id: folder,
        title: toTitle(folder),
        images: [],
        cover: mod.default,
      };
      acc.push(target);
    }

    target.images.push(mod.default);
    return acc;
  }, [] as GalleryFolder[])
  .map((folder) => {
    const sortedImages = [...folder.images].sort((a, b) => a.localeCompare(b));
    const preferredCover = sortedImages.find((src) => /_title\.[a-z]+$/i.test(src)) ?? sortedImages[0] ?? '';

    return {
      ...folder,
      images: sortedImages,
      cover: preferredCover,
    };
  })
  .sort((a, b) => a.title.localeCompare(b.title, 'en'));

export function GallerySection() {
  const [activeGallery, setActiveGallery] = useState<GalleryFolder | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const currentImage = useMemo(() => {
    if (!activeGallery) return null;
    return activeGallery.images[activeIndex] ?? null;
  }, [activeGallery, activeIndex]);

  const handleOpenGallery = useCallback((folder: GalleryFolder) => {
    setActiveGallery(folder);
    setActiveIndex(0);
  }, []);

  const handleClose = useCallback(() => {
    setActiveGallery(null);
    setActiveIndex(0);
  }, []);

  const handleStep = useCallback(
    (step: number) => {
      setActiveIndex((prev) => {
        if (!activeGallery) return prev;

        const total = activeGallery.images.length;
        if (total === 0) return 0;
        return (prev + step + total) % total;
      });
    },
    [activeGallery]
  );

  useEffect(() => {
    if (!activeGallery) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleStep(-1);
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleStep(1);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeGallery, handleClose, handleStep]);

  useEffect(() => {
    if (!activeGallery) return;

    const initialOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = initialOverflow;
    };
  }, [activeGallery]);

  return (
    <section id="gallery" className="border-t border-zinc-200/80 py-24 dark:border-zinc-800/80">
      <div className="container mx-auto max-w-7xl px-6">
        <div className="mb-12 grid gap-4 md:grid-cols-[160px_1fr] md:items-end">
          <p className="ui-font text-[10px] tracking-[0.24em] text-zinc-500 dark:text-zinc-400">01 / Projects</p>

          <div className="space-y-4">
            <h2 className="display-font max-w-4xl text-4xl leading-[0.95] text-zinc-900 sm:text-5xl dark:text-zinc-100">
              Архитектурная визуализация, которая выглядит как построенная реальность
            </h2>
            <p className="max-w-3xl text-zinc-600 dark:text-zinc-300">
              Каждая карточка ниже открывает отдельную проектную папку. Внутри кадры, отобранные для презентаций,
              альбомов и коммуникации с проектными командами.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-7 md:grid-cols-2">
          {galleryFolders.map((folder, index) => {
            const isWide = index % 3 === 0;

            return (
              <motion.button
                key={folder.id}
                type="button"
                className={`group relative overflow-hidden rounded-[1.8rem] border border-zinc-200/75 text-left shadow-[0_18px_55px_rgba(16,24,40,0.12)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/70 dark:border-zinc-700/70 dark:shadow-[0_18px_55px_rgba(0,0,0,0.45)] ${
                  isWide ? 'md:col-span-2' : ''
                }`}
                initial={{ opacity: 0, y: 26 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-12% 0px' }}
                transition={{ duration: 0.45, delay: index * 0.03 }}
                whileHover={{ y: -4 }}
                onClick={() => handleOpenGallery(folder)}
                aria-label={`Открыть галерею: ${folder.title}`}
              >
                <div className={`relative ${isWide ? 'aspect-[16/7]' : 'aspect-[4/5] md:aspect-[4/3]'}`}>
                  <ImageWithFallback
                    src={folder.cover}
                    alt={folder.title}
                    className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.03]"
                    loading="lazy"
                    decoding="async"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-900/70 via-zinc-900/10 to-zinc-900/0" />

                  <div className="absolute left-5 right-5 top-5 flex items-center justify-between">
                    <span className="ui-font rounded-full border border-white/30 bg-black/25 px-3 py-1 text-[9px] tracking-[0.22em] text-zinc-100 backdrop-blur-md">
                      Project {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="ui-font rounded-full border border-white/30 bg-black/25 px-3 py-1 text-[9px] tracking-[0.22em] text-zinc-100 backdrop-blur-md">
                      {folder.images.length} frames
                    </span>
                  </div>

                  <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-6">
                    <p className="display-font text-2xl leading-none text-zinc-50 sm:text-[2rem]">{folder.title}</p>
                    <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-100/90">
                      Открыть проект
                      <ArrowUpRight className="h-4 w-4" />
                    </p>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {activeGallery && currentImage && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            role="dialog"
            aria-modal="true"
            aria-label={`Галерея проекта: ${activeGallery.title}`}
          >
            <button
              type="button"
              className="absolute right-6 top-6 rounded-full border border-white/20 bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
              onClick={handleClose}
              aria-label="Закрыть галерею"
            >
              <X className="h-6 w-6" />
            </button>

            {activeGallery.images.length > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-6 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-white/10 p-3 text-white transition hover:bg-white/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleStep(-1);
                  }}
                  aria-label="Предыдущее изображение"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>

                <button
                  type="button"
                  className="absolute right-6 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-white/10 p-3 text-white transition hover:bg-white/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleStep(1);
                  }}
                  aria-label="Следующее изображение"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}

            <motion.div
              className="w-full max-w-6xl"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.28 }}
              onClick={(event) => event.stopPropagation()}
            >
              <ImageWithFallback
                src={currentImage}
                alt={activeGallery.title}
                className="h-auto w-full rounded-2xl"
                loading="eager"
                decoding="async"
              />

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-white/90">
                <p className="display-font text-2xl">{activeGallery.title}</p>
                <p className="ui-font text-[10px] tracking-[0.22em]">
                  frame {String(activeIndex + 1).padStart(2, '0')} / {String(activeGallery.images.length).padStart(2, '0')}
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
