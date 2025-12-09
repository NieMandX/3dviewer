import React, { useState } from 'react';
import { motion } from 'motion/react';

export function ContactSection() {
  return (
    <section id="contact" className="py-24 border-t border-zinc-200 dark:border-zinc-800">
      <div className="container mx-auto px-6 max-w-2xl">
        <motion.h2
          className="mb-12 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Связаться с нами
        </motion.h2>

        <motion.div
          className="space-y-4 text-center text-lg"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <div className="space-y-3">
            <a
              href="https://t.me/maragojeep"
              className="block font-semibold text-zinc-900 dark:text-zinc-100 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Telegram
            </a>
            <a
              href="tel:+79688962034"
              className="block font-semibold text-zinc-900 dark:text-zinc-100 hover:underline"
            >
              +7 968 896-20-34
            </a>
            <a
              href="tel:+79265881095"
              className="block font-semibold text-zinc-900 dark:text-zinc-100 hover:underline"
            >
              +7 926 588-10-95
            </a>
            <a
              href="mailto:ima.vision@yandex.com"
              className="block font-semibold text-zinc-900 dark:text-zinc-100 hover:underline"
            >
              ima.vision@yandex.com
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
