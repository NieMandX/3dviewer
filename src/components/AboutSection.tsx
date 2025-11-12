import React from 'react';
import { motion } from 'motion/react';

export function AboutSection() {
  return (
    <section id="about" className="py-24 border-t border-zinc-200 dark:border-zinc-800">
      <div className="container mx-auto px-6 max-w-4xl">
        <motion.h2
          className="mb-12 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          О студии
        </motion.h2>

        <motion.div
          className="space-y-6 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            Мы специализируемся на создании высокоточных архитектурных визуализаций и 3D моделей, которые полностью соответствуют требованиям Москомархитектуры.
          </p>
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            Наш подход сочетает техническую точность с эстетической ясностью, обеспечивая безупречное качество на всех этапах проекта.
          </p>
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            От концепции до финальной подачи — мы гарантируем профессиональное исполнение и полное соответствие стандартам АГР.
          </p>
        </motion.div>
      </div>
    </section>
  );
}