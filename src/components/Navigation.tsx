import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';

const navItems = [
  { label: 'Визуализация', href: '#gallery' },
  { label: 'Модели', href: '#models' },
  { label: 'О нас', href: '#about' },
  { label: 'Контакты', href: '#contact' }
];

export function Navigation() {
  const [activeSection, setActiveSection] = useState('');

  useEffect(() => {
    const handleScroll = () => {
      const sections = navItems.map(item => item.href.substring(1));
      
      for (const section of sections) {
        const element = document.getElementById(section);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.top <= 150 && rect.bottom >= 150) {
            setActiveSection(section);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    const element = document.querySelector(href);
    if (element) {
      const offset = 120; // Header + nav height
      const elementPosition = element.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - offset;

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
    }
  };

  return (
    <nav className="sticky top-[57px] z-40 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md transition-colors duration-300">
      <div className="container mx-auto px-6 max-w-7xl">
        <ul className="flex items-center justify-center gap-8 py-4">
          {navItems.map((item, index) => {
            const isActive = activeSection === item.href.substring(1);
            return (
              <motion.li
                key={item.href}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: index * 0.1 }}
              >
                <a
                  href={item.href}
                  onClick={(e) => handleClick(e, item.href)}
                  className={`relative transition-colors hover:text-zinc-900 dark:hover:text-zinc-100 ${
                    isActive 
                      ? 'text-zinc-900 dark:text-zinc-100' 
                      : 'text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <motion.div
                      layoutId="activeSection"
                      className="absolute -bottom-4 left-0 right-0 h-px bg-zinc-900 dark:bg-zinc-100"
                      transition={{ duration: 0.3 }}
                    />
                  )}
                </a>
              </motion.li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
