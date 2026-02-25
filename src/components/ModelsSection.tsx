import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

const processImage = new URL(
  '../assets/vis_img/APEX-Residential_Tolbuhino-Moscow/APEX-Residential_Tolbuhino-Moscow_title.webp',
  import.meta.url
).href;

const detailImage = new URL(
  '../assets/vis_img/APEX-Residential_complex-Moscow/1.jpg',
  import.meta.url
).href;

const services = [
  {
    code: '01',
    title: 'АГР High / Low Poly Models',
    description:
      'Подготавливаем модели в полном соответствии с требованиями МКА: структура, материалы, масштаб, проверка ошибок и экспорт.',
  },
  {
    code: '02',
    title: 'Visualization & Animation',
    description:
      'Создаем визуализации и анимацию параллельно модели. Это устраняет расхождения между презентацией и технической подачей.',
  },
  {
    code: '03',
    title: 'Technical QA Pipeline',
    description:
      'Проводим проверку перед отправкой: геометрия, UV/текстуры, naming и финальная валидация через внутренние пайплайн-инструменты.',
  },
];

export function ModelsSection() {
  return (
    <section id="models" className="border-t border-zinc-200/80 py-24 dark:border-zinc-800/80">
      <div className="container mx-auto max-w-7xl px-6">
        <div className="mb-12 grid gap-4 md:grid-cols-[160px_1fr] md:items-end">
          <p className="ui-font text-[10px] tracking-[0.24em] text-zinc-500 dark:text-zinc-400">02 / Services</p>

          <div className="space-y-4">
            <h2 className="display-font max-w-4xl text-4xl leading-[0.95] text-zinc-900 sm:text-5xl dark:text-zinc-100">
              Единый pipeline для визуализации и АГР-моделей
            </h2>
            <p className="max-w-3xl text-zinc-600 dark:text-zinc-300">
              Мы работаем на стыке архитектуры, 3D-продакшна и инженерной проверки. Такой подход сокращает правки,
              ускоряет согласование и делает итоговые материалы предсказуемыми.
            </p>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[1.02fr_0.98fr] lg:items-start">
          <motion.div
            className="relative overflow-hidden rounded-[2rem] border border-zinc-200/80 bg-zinc-100 shadow-[0_24px_65px_rgba(15,23,42,0.14)] dark:border-zinc-700/80 dark:bg-zinc-900 dark:shadow-[0_24px_65px_rgba(0,0,0,0.5)]"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-10% 0px' }}
            transition={{ duration: 0.6 }}
          >
            <ImageWithFallback
              src={processImage}
              alt="Pipeline визуализации и АГР"
              className="h-[480px] w-full object-cover sm:h-[560px]"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-900/65 via-zinc-900/15 to-transparent" />

            <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8">
              <p className="ui-font text-[10px] tracking-[0.22em] text-zinc-200">Pipeline View</p>
              <p className="display-font mt-2 text-3xl leading-none text-zinc-50">Submission-ready deliverables</p>
            </div>

            <div className="absolute right-5 top-5 hidden w-[190px] overflow-hidden rounded-2xl border border-white/30 bg-black/15 backdrop-blur-md sm:block">
              <ImageWithFallback src={detailImage} alt="Model detail" className="h-28 w-full object-cover" loading="lazy" />
              <div className="p-3 text-zinc-100">
                <p className="ui-font text-[9px] tracking-[0.2em]">QC Snapshot</p>
                <p className="mt-2 text-xs">Geometry, materials and scale verification.</p>
              </div>
            </div>
          </motion.div>

          <div className="space-y-4">
            {services.map((service, index) => (
              <motion.article
                key={service.code}
                className="rounded-[1.4rem] border border-zinc-200/80 bg-white/75 p-6 backdrop-blur-sm dark:border-zinc-700/80 dark:bg-zinc-900/65"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-10% 0px' }}
                transition={{ duration: 0.45, delay: index * 0.08 }}
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span className="ui-font rounded-full bg-zinc-900 px-3 py-1 text-[10px] tracking-[0.18em] text-zinc-100 dark:bg-zinc-100 dark:text-zinc-900">
                    {service.code}
                  </span>
                  <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
                </div>
                <h3 className="display-font text-3xl leading-none text-zinc-900 dark:text-zinc-100">{service.title}</h3>
                <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-300">{service.description}</p>
              </motion.article>
            ))}

            <motion.div
              className="rounded-[1.4rem] border border-zinc-300/80 bg-zinc-900 p-6 text-zinc-100 dark:border-zinc-600 dark:bg-zinc-100 dark:text-zinc-900"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: 0.2 }}
            >
              <p className="ui-font text-[10px] tracking-[0.2em] text-zinc-300 dark:text-zinc-500">Tooling</p>
              <p className="mt-3 text-lg leading-relaxed">
                Мы являемся авторами AGR WebViewer - инструмента для быстрой визуальной проверки и диагностики ошибок в
                АГР-моделях.
              </p>
              <a
                href="https://agr.vision/"
                className="mt-4 inline-flex items-center gap-2 text-sm underline-offset-4 transition hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Открыть agr.vision
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
