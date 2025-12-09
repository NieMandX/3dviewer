import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface ModelCard {
  id: number;
  url: string;
  title: string;
  description: string;
}

const modelCards: ModelCard[] = [
  {
    id: 1,
    url: 'https://images.unsplash.com/photo-1633355303026-28d096d08c42?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHwzZCUyMGFyY2hpdGVjdHVyZSUyMG1vZGVsfGVufDF8fHx8MTc2Mjk1NjY2OHww&ixlib=rb-4.1.0&q=80&w=1080',
    title: 'Высокополигональные модели',
    description: 'Детализированные модели для презентаций и визуализаций'
  },
  {
    id: 2,
    url: 'https://images.unsplash.com/photo-1562957982-b1f25317aebd?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxidWlsZGluZyUyMHdpcmVmcmFtZXxlbnwxfHx8fDE3NjI5NTY2Njh8MA&ixlib=rb-4.1.0&q=80&w=1080',
    title: 'Низкополигональные модели',
    description: 'Оптимизированные модели для интерактивных приложений'
  },
  {
    id: 3,
    url: 'https://images.unsplash.com/photo-1749464251742-107093fc5650?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxhcmNoaXRlY3R1cmFsJTIwdmlzdWFsaXphdGlvbnxlbnwxfHx8fDE3NjI5MTI4ODh8MA&ixlib=rb-4.1.0&q=80&w=1080',
    title: 'AGR модели МКА',
    description: 'Соответствие требованиям Москомархитектуры'
  },
];

export function ModelsSection() {
  const [selectedImage, setSelectedImage] = useState<ModelCard | null>(null);

  return (
    <section id="models" className="py-24 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
      <div className="container mx-auto px-6 max-w-7xl">
        {/* <motion.h2
          className="mb-16 text-center font-bold"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          3D Модели АГР
        </motion.h2> */}

        <div className="mx-auto mb-16 space-y-6 max-w-6xl">
          <motion.p
            className="text-zinc-700 dark:text-zinc-300 leading-relaxed"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            Мы занимаемся комплексной подготовкой материалов для подачи в Москомархитектуру (МКА). Процесс создания рендеров ведётся параллельно с разработкой высоко- и низкополигональных моделей, что позволяет исключить расхождения между изображениями в альбоме и 3D моделями.
          </motion.p>

          <motion.p
            className="text-zinc-700 dark:text-zinc-300 leading-relaxed"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            Мы являемся авторами{' '}
            <a
              href="https://agr.vision/"
              className="text-zinc-900 font-semibold underline-offset-4 hover:underline dark:text-white"
              target="_blank"
              rel="noreferrer"
            >
              AGR WebViewer
            </a>{' '}
            — простого, удобного и бесплатного инструмента для визуального анализа ошибок и погрешностей в АГР моделях. Достаточно открыть сайт{' '}
            <a
              href="https://agr.vision/"
              className="text-zinc-900 font-semibold underline-offset-4 hover:underline dark:text-white"
              target="_blank"
              rel="noreferrer"
            >
              agr.vision
            </a>{' '}
            и перетащить ZIP-архив с моделью прямо в окно браузера — система автоматически соберёт и отобразит модель максимально приближенно к тому, как её видят специалисты МКА и МГТ. Вьюер постоянно дорабатывается и улучшается, в нем становятся доступны новые функции.
          </motion.p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {modelCards.map((card, index) => (
            <motion.div
              key={card.id}
              className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 overflow-hidden cursor-pointer group"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              whileHover={{ y: -4 }}
              onClick={() => setSelectedImage(card)}
            >
              <div className="aspect-video bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
                <ImageWithFallback
                  src={card.url}
                  alt={card.title}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </div>
              <div className="p-6">
                <h3 className="mb-2">{card.title}</h3>
                <p className="text-zinc-600 dark:text-zinc-400">{card.description}</p>
              </div>
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
              <div className="text-white text-center mt-6">
                <h3 className="mb-2">{selectedImage.title}</h3>
                <p className="text-zinc-400">{selectedImage.description}</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
