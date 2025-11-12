import React from 'react';
import { motion } from 'motion/react';

export function HeroSection() {
  return (
    <section className="min-h-screen flex items-center justify-center relative overflow-hidden pt-20">
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

      <div className="container mx-auto px-6 max-w-4xl text-center relative z-10">
        <motion.h1
          className="mb-6 tracking-tight"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          Визуализация, 3D Модели АГР, Анимация.
        </motion.h1>
        
        <motion.p
          className="text-zinc-600 dark:text-zinc-400 max-w-3xl mx-auto leading-relaxed"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
        >
          Архитектурная визуализация и анимация. Разработка низкополигональных и высокополигональных 3D моделей для АГР в соответствии с требованиями МКА. Интерактивная WEB презентация
        </motion.p>
      </div>
    </section>
  );
}
