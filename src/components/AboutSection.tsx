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
        </motion.h2>

        <motion.div
          className="space-y-6 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            Мы специализируемся на создании качественной архитектурной визуализации, 3D анимации и разработкой высокополигональных/низкополигональных 3D моделей для прохождения АГР, в соответствии с самыми актуальными требованиями Москомархитектуры.
          </p>
          <br />
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            Наша команда состоит из архитекторов, 3D художников и программистов - разработчиков. Мы работаем в архитектурном пространстве Москвы с 2018. За плечами более 300 завершенных проектов разной степени сложности, для ведущих архитектурных и девелоперских компаний столицы.
          </p>
          <br />
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            Нам доверяют:
          </p>
          <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
            <strong>Sergey Skuratov Architects, APEX project buro, Capital Group</strong> и многие другие.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
