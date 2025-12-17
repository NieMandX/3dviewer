import React from 'react';
import { motion } from 'motion/react';

const stats = [
  { value: '300+', label: 'проектов и конкурсов' },
  { value: '40+', label: 'моделей АГР для МКА' },
  { value: '12', label: 'постоянных клиентов' }
];

export function HeroSection() {
  return (
    <section className="relative -mt-12 lg:-mt-16 overflow-hidden pt-8 pb-28 md:pt-8 md:pb-a">
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
              className="text-2xl sm:text-3xl md:text-3xl lg:text-4xl xl:text-4xl font-light text-left leading-tight tracking-tight text-zinc-600 dark:text-zinc-50"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1 }}
            >
              <div className="space-y-2">
                <p>Архитектурная визуализация и анимация.</p>
              </div>

              <div className="space-y-2 text-right pt-4">
                <p>АГР модели для МКА.</p>
              </div>

            </motion.h1>

            <motion.p
              className="pt-2 pb-2 mt-6 text-[16px] sm:text-[16px] md:text-[16px] lg:text-[16px] xl:text-[20px] font-light text-lg leading-relaxed text-zinc-600 dark:text-zinc-300"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              Совместная разработка АГР 3D-моделей и архитектурной визуализации, сохраняет единый визуальный язык проекта. Исключает расхождения между АГР материалами.
            </motion.p>

            <motion.div
              className="mt-6 grid gap-6 grid-cols-3"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.5 }}
            >
              {stats.map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-zinc-200/80 bg-white/60 p-3 text-left shadow-[0_20px_45px_rgba(15,23,42,0.08)] dark:border-zinc-800/80 dark:bg-zinc-950/60 dark:shadow-[0_20px_45px_rgba(0,0,0,0.35)]"
                >
                  <p className="text-2xl text-black font-semibold text-zinc-900 dark:text-white">{item.value}</p>
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
