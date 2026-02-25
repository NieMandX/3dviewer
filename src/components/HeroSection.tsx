import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

const heroImage = new URL(
  '../assets/vis_img/Sergey_Skuratov_Architects-Afi_Tower-Moscow/Sergey_Skuratov_Architects-Afi_Tower-Moscow_title.webp',
  import.meta.url
).href;

const sideImageTop = new URL(
  '../assets/vis_img/APEX-Chasovaya-Moscow/APEX-Chasovaya-Moscow_title.webp',
  import.meta.url
).href;

const sideImageBottom = new URL(
  '../assets/vis_img/APEX-Fonchenko-Moscow/APEX-Fonchenko-Moscow_title.webp',
  import.meta.url
).href;

const stats = [
  { value: '300+', label: 'Projects & competitions' },
  { value: '40+', label: 'AGR models approved' },
  { value: '12', label: 'Long-term clients' },
];

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pb-24 pt-10 sm:pt-14">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_16%_4%,rgba(17,55,80,0.13),transparent_44%),radial-gradient(circle_at_86%_14%,rgba(152,113,54,0.13),transparent_42%)] dark:bg-[radial-gradient(circle_at_18%_6%,rgba(69,117,148,0.2),transparent_45%),radial-gradient(circle_at_82%_18%,rgba(178,126,61,0.18),transparent_44%)]" />

      <div className="container mx-auto max-w-7xl px-6">
        <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
          <div>
            <motion.p
              className="ui-font mb-5 text-[11px] tracking-[0.24em] text-zinc-500 dark:text-zinc-400"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55 }}
            >
              IMA Vision / Architectural Visualization Studio
            </motion.p>

            <motion.h1
              className="display-font max-w-2xl text-5xl leading-[0.95] tracking-[0.01em] text-zinc-900 sm:text-6xl lg:text-7xl dark:text-zinc-50"
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.08 }}
            >
              Архитектурные
              <span className="block text-zinc-500 dark:text-zinc-300">образы</span>
              с точностью до АГР
            </motion.h1>

            <motion.p
              className="mt-8 max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg dark:text-zinc-300"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.18 }}
            >
              Мы синхронизируем визуализацию и 3D-модели в одном производственном цикле. Это исключает расхождения
              между презентационными материалами, альбомами и АГР-подачей в МКА.
            </motion.p>

            <motion.div
              className="mt-9 flex flex-wrap items-center gap-3"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.28 }}
            >
              <a
                href="#gallery"
                className="group inline-flex items-center gap-2 rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-zinc-50 transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Смотреть проекты
                <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </a>
              <a
                href="#contact"
                className="ui-font inline-flex rounded-full border border-zinc-300 px-5 py-3 text-[10px] tracking-[0.2em] text-zinc-700 transition hover:border-zinc-500 hover:text-zinc-950 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
              >
                Brief & Estimate
              </a>
            </motion.div>

            <motion.div
              className="mt-10 grid gap-4 sm:grid-cols-3"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.34 }}
            >
              {stats.map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-zinc-200/90 bg-white/65 p-4 backdrop-blur-sm dark:border-zinc-800/90 dark:bg-zinc-900/60"
                >
                  <p className="display-font text-3xl text-zinc-900 dark:text-zinc-100">{item.value}</p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{item.label}</p>
                </div>
              ))}
            </motion.div>
          </div>

          <motion.div
            className="relative"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.16 }}
          >
            <div className="relative overflow-hidden rounded-[2rem] border border-zinc-200/70 bg-zinc-100 shadow-[0_35px_100px_rgba(20,28,36,0.2)] dark:border-zinc-700/70 dark:bg-zinc-900 dark:shadow-[0_35px_100px_rgba(0,0,0,0.55)]">
              <ImageWithFallback
                src={heroImage}
                alt="Флагманский проект IMA Vision"
                className="h-[420px] w-full object-cover sm:h-[520px]"
                loading="eager"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-zinc-900/55 via-zinc-900/5 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8">
                <p className="ui-font text-[10px] tracking-[0.22em] text-zinc-200">Featured Case</p>
                <p className="display-font mt-2 text-3xl leading-none text-zinc-50">Afi Tower, Moscow</p>
              </div>
            </div>

            <div className="pointer-events-none absolute -bottom-8 -left-6 hidden w-[180px] overflow-hidden rounded-3xl border border-zinc-200/80 bg-white/80 shadow-[0_15px_45px_rgba(15,23,42,0.2)] backdrop-blur-sm sm:block dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:shadow-[0_15px_45px_rgba(0,0,0,0.45)]">
              <ImageWithFallback src={sideImageTop} alt="Supplementary project still" className="h-40 w-full object-cover" />
            </div>

            <div className="pointer-events-none absolute -right-6 top-8 hidden w-[180px] overflow-hidden rounded-3xl border border-zinc-200/80 bg-white/80 shadow-[0_15px_45px_rgba(15,23,42,0.2)] backdrop-blur-sm xl:block dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:shadow-[0_15px_45px_rgba(0,0,0,0.45)]">
              <ImageWithFallback
                src={sideImageBottom}
                alt="Supplementary project still"
                className="h-44 w-full object-cover"
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
