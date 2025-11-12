import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface GalleryItem {
  id: number;
  url: string;
  title: string;
}

// Generate 30 gallery items with placeholder images
const galleryItems: GalleryItem[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  url: i % 6 === 0 ? 'https://images.unsplash.com/photo-1749464251742-107093fc5650?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxhcmNoaXRlY3R1cmFsJTIwdmlzdWFsaXphdGlvbnxlbnwxfHx8fDE3NjI5MTI4ODh8MA&ixlib=rb-4.1.0&q=80&w=1080'
    : i % 6 === 1 ? 'https://images.unsplash.com/photo-1737555070365-cb948afc334c?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtb2Rlcm4lMjBhcmNoaXRlY3R1cmUlMjByZW5kZXJ8ZW58MXx8fHwxNzYyOTU2NjY4fDA&ixlib=rb-4.1.0&q=80&w=1080'
    : i % 6 === 2 ? 'https://images.unsplash.com/photo-1633355303026-28d096d08c42?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHwzZCUyMGFyY2hpdGVjdHVyZSUyMG1vZGVsfGVufDF8fHx8MTc2Mjk1NjY2OHww&ixlib=rb-4.1.0&q=80&w=1080'
    : i % 6 === 3 ? 'https://images.unsplash.com/photo-1562957982-b1f25317aebd?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxidWlsZGluZyUyMHdpcmVmcmFtZXxlbnwxfHx8fDE3NjI5NTY2Njh8MA&ixlib=rb-4.1.0&q=80&w=1080'
    : i % 6 === 4 ? 'https://images.unsplash.com/photo-1542621334-a254cf47733d?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxhcmNoaXRlY3R1cmFsJTIwZHJhd2luZ3xlbnwxfHx8fDE3NjI5NTY2Njl8MA&ixlib=rb-4.1.0&q=80&w=1080'
    : 'https://images.unsplash.com/photo-1549791084-5f78368b208b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtaW5pbWFsaXN0JTIwYXJjaGl0ZWN0dXJlfGVufDF8fHx8MTc2MjkzNTEwNXww&ixlib=rb-4.1.0&q=80&w=1080',
  title: `Проект ${i + 1}`
}));

export function GallerySection() {
  const [selectedImage, setSelectedImage] = useState<GalleryItem | null>(null);

  return (
    <section id="gallery" className="py-24 border-t border-zinc-200 dark:border-zinc-800">
      <div className="container mx-auto px-6 max-w-7xl">
        <motion.h2
          className="mb-16 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Визуализация и Анимация
        </motion.h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {galleryItems.map((item, index) => (
            <motion.div
              key={item.id}
              className="aspect-video bg-zinc-100 dark:bg-zinc-900 cursor-pointer overflow-hidden group"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.02 }}
              whileHover={{ scale: 1.02 }}
              onClick={() => setSelectedImage(item)}
            >
              <ImageWithFallback
                src={item.url}
                alt={item.title}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
            </motion.div>
          ))}
        </div>
      </div>

      {/* Lightbox Modal */}
      <AnimatePresence>
        {selectedImage && (
          <motion.div
            className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedImage(null)}
          >
            <button
              className="absolute top-6 right-6 p-2 text-white hover:bg-white/10 rounded-full transition-colors"
              onClick={() => setSelectedImage(null)}
            >
              <X className="w-6 h-6" />
            </button>
            
            <motion.div
              className="max-w-6xl w-full"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <ImageWithFallback
                src={selectedImage.url}
                alt={selectedImage.title}
                className="w-full h-auto"
              />
              <p className="text-white text-center mt-4">{selectedImage.title}</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}