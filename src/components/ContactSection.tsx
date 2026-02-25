import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight } from 'lucide-react';

const contactLinks = [
  {
    label: 'Telegram',
    value: '@maragojeep',
    href: 'https://t.me/maragojeep',
  },
  {
    label: 'Phone',
    value: '+7 968 896-20-34',
    href: 'tel:+79688962034',
  },
  {
    label: 'Phone',
    value: '+7 926 588-10-95',
    href: 'tel:+79265881095',
  },
  {
    label: 'Email',
    value: 'ima.vision@yandex.com',
    href: 'mailto:ima.vision@yandex.com',
  },
];

export function ContactSection() {
  return (
    <section id="contact" className="border-t border-zinc-200/80 py-24 dark:border-zinc-800/80">
      <div className="container mx-auto max-w-7xl px-6">
        <motion.div
          className="relative overflow-hidden rounded-[2rem] border border-zinc-200/80 bg-zinc-950 p-8 text-zinc-100 shadow-[0_30px_90px_rgba(9,13,19,0.45)] sm:p-10 dark:border-zinc-700/80"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.55 }}
        >
          <div className="pointer-events-none absolute -left-28 top-1/2 h-72 w-72 -translate-y-1/2 rounded-full bg-sky-500/20 blur-3xl" />
          <div className="pointer-events-none absolute -right-20 top-8 h-64 w-64 rounded-full bg-amber-400/20 blur-3xl" />

          <div className="relative grid gap-10 lg:grid-cols-[1fr_0.95fr] lg:items-end">
            <div>
              <p className="ui-font text-[10px] tracking-[0.24em] text-zinc-300">04 / Contact</p>
              <h2 className="display-font mt-4 max-w-2xl text-4xl leading-[0.95] text-white sm:text-5xl">
                Обсудим ваш проект и подготовим production-стратегию
              </h2>
              <p className="mt-6 max-w-xl text-zinc-300">
                Напишите нам с базовыми вводными: стадия проекта, тип материалов и дедлайн. Мы предложим структуру
                работ, график и формат передачи.
              </p>

              <a
                href="https://t.me/maragojeep"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-8 inline-flex items-center gap-2 rounded-full border border-zinc-500/70 bg-white/10 px-5 py-3 text-sm text-zinc-100 transition hover:bg-white/20"
              >
                Написать в Telegram
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>

            <div className="space-y-3">
              {contactLinks.map((contact) => (
                <a
                  key={`${contact.label}-${contact.value}`}
                  href={contact.href}
                  target={contact.href.startsWith('http') ? '_blank' : undefined}
                  rel={contact.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className="group flex items-center justify-between rounded-2xl border border-zinc-700/70 bg-white/5 px-5 py-4 transition hover:border-zinc-500 hover:bg-white/10"
                >
                  <span className="ui-font text-[10px] tracking-[0.2em] text-zinc-400">{contact.label}</span>
                  <span className="text-right text-sm font-medium text-zinc-100 sm:text-base">{contact.value}</span>
                </a>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
