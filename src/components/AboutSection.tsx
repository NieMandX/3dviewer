import React from 'react';
import { motion } from 'motion/react';

const metrics = [
  { value: '2018', label: 'Year founded' },
  { value: '300+', label: 'Completed projects' },
  { value: 'Moscow', label: 'Core market' },
];

export function AboutSection() {
  return (
    <section id="about" className="border-t border-zinc-200/80 py-24 dark:border-zinc-800/80">
      <div className="container mx-auto max-w-7xl px-6">
        <div className="grid gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-start">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-10% 0px' }}
            transition={{ duration: 0.55 }}
          >
            <p className="ui-font text-[10px] tracking-[0.24em] text-zinc-500 dark:text-zinc-400">03 / Studio</p>
            <h2 className="display-font mt-4 max-w-2xl text-4xl leading-[0.95] text-zinc-900 sm:text-5xl dark:text-zinc-100">
              Команда архитекторов, CG-художников и технических специалистов
            </h2>
            <p className="mt-7 max-w-2xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-300">
              IMA Vision работает в архитектурном контуре Москвы с 2018 года. Мы объединяем визуальную выразительность
              и техническую точность: от конкурсных рендеров до submission-ready АГР-пакетов.
            </p>
            <p className="mt-5 max-w-2xl leading-relaxed text-zinc-600 dark:text-zinc-300">
              Среди клиентов: Sergey Skuratov Architects, APEX project buro, Capital Group и другие студии и девелоперы,
              для которых важны качество подачи и скорость прохождения согласований.
            </p>
          </motion.div>

          <motion.div
            className="space-y-4"
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-10% 0px' }}
            transition={{ duration: 0.55, delay: 0.08 }}
          >
            {metrics.map((metric) => (
              <article
                key={metric.label}
                className="rounded-[1.4rem] border border-zinc-200/80 bg-white/70 p-6 backdrop-blur-sm dark:border-zinc-700/80 dark:bg-zinc-900/60"
              >
                <p className="display-font text-4xl leading-none text-zinc-900 dark:text-zinc-100">{metric.value}</p>
                <p className="ui-font mt-3 text-[10px] tracking-[0.2em] text-zinc-500 dark:text-zinc-400">{metric.label}</p>
              </article>
            ))}

            <article className="rounded-[1.4rem] border border-zinc-200/80 bg-gradient-to-br from-zinc-50 to-zinc-100 p-6 dark:border-zinc-700/80 dark:from-zinc-900 dark:to-zinc-800">
              <p className="ui-font text-[10px] tracking-[0.2em] text-zinc-500 dark:text-zinc-400">Focus</p>
              <p className="display-font mt-3 text-3xl leading-none text-zinc-900 dark:text-zinc-100">Architecture First</p>
              <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-300">
                Визуальный язык проекта формируется вместе с моделью, а не после. Это и есть основа предсказуемого
                production-процесса.
              </p>
            </article>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
