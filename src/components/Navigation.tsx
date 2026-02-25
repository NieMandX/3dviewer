import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';

const navItems = [
  { label: 'Projects', href: '#gallery' },
  { label: 'Services', href: '#models' },
  { label: 'Studio', href: '#about' },
  { label: 'Contact', href: '#contact' },
];

const NAV_OFFSET = 132;

export function Navigation() {
  const [activeSection, setActiveSection] = useState('');

  useEffect(() => {
    const handleScroll = () => {
      const sections = navItems.map((item) => item.href.substring(1));

      for (const section of sections) {
        const element = document.getElementById(section);
        if (!element) continue;

        const rect = element.getBoundingClientRect();
        if (rect.top <= NAV_OFFSET && rect.bottom >= NAV_OFFSET) {
          setActiveSection(section);
          return;
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();

    const element = document.querySelector(href);
    if (!element) return;

    const elementPosition = element.getBoundingClientRect().top;
    const offsetPosition = elementPosition + window.scrollY - NAV_OFFSET;

    window.scrollTo({
      top: offsetPosition,
      behavior: 'smooth',
    });
  };

  return (
    <nav className="sticky top-[76px] z-40 mt-[76px] py-4">
      <div className="container mx-auto max-w-7xl px-6">
        <div className="mx-auto w-full max-w-3xl overflow-x-auto rounded-full border border-zinc-200/80 bg-white/75 p-2 shadow-[0_14px_45px_rgba(16,24,40,0.08)] backdrop-blur-xl dark:border-zinc-800/80 dark:bg-zinc-900/70 dark:shadow-[0_14px_45px_rgba(0,0,0,0.4)]">
          <ul className="flex min-w-max items-center justify-between gap-1">
            {navItems.map((item, index) => {
              const isActive = activeSection === item.href.substring(1);

              return (
                <motion.li
                  key={item.href}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, delay: index * 0.06 }}
                >
                  <a
                    href={item.href}
                    onClick={(event) => handleClick(event, item.href)}
                    className={`ui-font relative inline-flex rounded-full px-4 py-2 text-[10px] tracking-[0.2em] transition md:px-5 ${
                      isActive
                        ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                        : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {item.label}
                  </a>
                </motion.li>
              );
            })}
          </ul>
        </div>
      </div>
    </nav>
  );
}
