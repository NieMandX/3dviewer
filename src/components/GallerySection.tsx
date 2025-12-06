import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

type GalleryFolder = {
  id: string;
  title: string;
  images: string[];
  cover: string;
};

const FOLDER_TITLES: Record<string, string> = {
  'concept-tower': 'Концепция башни',
  'atrium-light': 'Атриум и свет',
  'riverfront-pier': 'Пирс и набережная'
};

const galleryModules = import.meta.glob<{ default: string }>(
  '../assets/vis_img/*/*.{jpg,jpeg,png,webp}',
  { eager: true }
);

const galleryFolders: GalleryFolder[] = (Object.entries(galleryModules) as [string, { default: string }][])
  .reduce(
  (acc, [path, mod]) => {
    const match = path.match(/\.\.\/assets\/vis_img\/([^/]+)\//);
    if (!match) return acc;
    const [, folder] = match;
    let target = acc.find(group => group.id === folder);
    if (!target) {
      target = {
        id: folder,
        title: FOLDER_TITLES[folder] ?? folder.replace(/-/g, ' '),
        images: [],
        cover: mod.default
      };
      acc.push(target);
    }
    target.images.push(mod.default);
    target.cover = target.images[0];
    return acc;
  },
  [] as GalleryFolder[]
)
  .map(folder => {
    const sortedImages = [...folder.images].sort();
    return {
      ...folder,
      images: sortedImages,
      cover: sortedImages[0]
    };
  })
  .sort((a, b) => a.title.localeCompare(b.title));

export function GallerySection() {
  const [activeGallery, setActiveGallery] = useState<GalleryFolder | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const currentImage = useMemo(() => {
    if (!activeGallery) return null;
    return activeGallery.images[activeIndex] ?? null;
  }, [activeGallery, activeIndex]);

  const handleOpenGallery = (folder: GalleryFolder) => {
    setActiveGallery(folder);
    setActiveIndex(0);
  };

  const handleClose = () => {
    setActiveGallery(null);
    setActiveIndex(0);
  };

  const handleStep = (step: number) => {
    if (!activeGallery) return;
    setActiveIndex(prev => {
      const total = activeGallery.images.length;
      if (total === 0) return 0;
      return (prev + step + total) % total;
    });
  };

  useEffect(() => {
    if (!activeGallery) return;

    const handleKey = (event: KeyboardEvent) => {
      if (!activeGallery) return;
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
  }, [activeGallery]);

  return (
    <section id="gallery" className="py-24 border-t border-zinc-200 dark:border-zinc-800">
      <div className="container mx-auto px-6 max-w-7xl">
        {/* <motion.h2
          className="mb-16 text-center font-bold"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
        </motion.h2> */}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {galleryFolders.map((folder, index) => (
            <motion.div
              key={folder.id}
              className="relative aspect-video bg-zinc-100 dark:bg-zinc-900 cursor-pointer overflow-hidden group"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.02 }}
              whileHover={{ scale: 1.02 }}
              onClick={() => handleOpenGallery(folder)}
            >
              <ImageWithFallback
                src={folder.cover}
                alt={folder.title}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end">
                <div className="p-4 text-white">
                  <p className="text-sm font-medium">{folder.title}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Lightbox Modal */}
      <AnimatePresence>
        {activeGallery && currentImage && (
          <motion.div
            className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
          >
            <button
              className="absolute top-6 right-6 p-2 text-white hover:bg-white/10 rounded-full transition-colors"
              onClick={handleClose}
            >
              <X className="w-6 h-6" />
            </button>

            {activeGallery.images.length > 1 && (
              <>
                <button
                  className="absolute left-8 top-1/2 -translate-y-1/2 p-3 text-white/80 hover:text-white transition"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStep(-1);
                  }}
                  aria-label="Предыдущее изображение"
                >
                  <ChevronLeft className="w-8 h-8" />
                </button>
                <button
                  className="absolute right-8 top-1/2 -translate-y-1/2 p-3 text-white/80 hover:text-white transition"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStep(1);
                  }}
                  aria-label="Следующее изображение"
                >
                  <ChevronRight className="w-8 h-8" />
                </button>
              </>
            )}
            
            <motion.div
              className="max-w-6xl w-full"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <ImageWithFallback
                src={currentImage}
                alt={activeGallery.title}
                className="w-full h-auto"
              />
              <p className="text-white text-center mt-4">
                {activeGallery.title} — кадр {activeIndex + 1} из {activeGallery.images.length}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
