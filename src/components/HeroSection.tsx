import React from 'react';
import { motion } from 'motion/react';

const stats = [
  { value: '230+', label: 'проектов и конкурсов' },
  { value: '58', label: 'пакетов АГР для МКА' },
  { value: '12', label: 'постоянных партнёров' }
];

export function HeroSection() {
  return (
    <section className="relative -mt-12 lg:-mt-16 overflow-hidden pt-10 pb-28 md:pt-16 md:pb-36">
      {/* Abstract line animation background */}
      <div className="absolute inset-0 opacity-5 dark:opacity-10">
        <svg className="w-full h-full" viewBox="0 0 1000 1000">
          <motion.line
            x1="0"
            y1="500"
            x2="1000"
            y2="500"
            stroke="currentColor"
            strokeWidth="0.5"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 2, ease: "easeInOut" }}
          />
          <motion.line
            x1="500"
            y1="0"
            x2="500"
            y2="1000"
            stroke="currentColor"
            strokeWidth="0.5"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 2, delay: 0.2, ease: "easeInOut" }}
          />
          <motion.circle
            cx="500"
            cy="500"
            r="200"
            stroke="currentColor"
            strokeWidth="0.5"
            fill="none"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 2, delay: 0.4, ease: "easeInOut" }}
          />
          <motion.rect
            x="350"
            y="350"
            width="300"
            height="300"
            stroke="currentColor"
            strokeWidth="0.5"
            fill="none"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 2, delay: 0.6, ease: "easeInOut" }}
          />
        </svg>
      </div>

      <div className="absolute inset-0 bg-gradient-to-b from-white via-white/70 to-transparent dark:from-zinc-950 dark:via-zinc-950/40" />

      <div className="container mx-auto px-6 max-w-6xl relative z-10">
        <div className="max-w-4xl mx-auto">
          <div>
            <motion.h1
              className="font-black leading-tight tracking-tight text-zinc-900 dark:text-zinc-50"
              style={{ fontSize: 'clamp(2.75rem, 5vw, 6.5rem)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1 }}
            >
              Архитектурная визуализация и анимация. АГР модели для МКА. Код.
            </motion.h1>

            <motion.p
              className="mt-6 text-lg leading-relaxed text-zinc-600 dark:text-zinc-300"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              Совмещаем визуализацию, изготовление 3D моделей для подготовку полного пакета АГР. 
              Синхронная работа команд исключает расхождения между слайдами альбома и АГР моделями.
            </motion.p>

            <motion.div
              className="mt-10 grid gap-6 sm:grid-cols-3"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.5 }}
            >
              {stats.map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-zinc-200/80 bg-white/60 p-5 text-left shadow-[0_20px_45px_rgba(15,23,42,0.08)] dark:border-zinc-800/80 dark:bg-zinc-950/60 dark:shadow-[0_20px_45px_rgba(0,0,0,0.35)]"
                >
                  <p className="text-3xl font-medium text-zinc-900 dark:text-white">{item.value}</p>
                  <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{item.label}</p>
                </div>
              ))}
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
