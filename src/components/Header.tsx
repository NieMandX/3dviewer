import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../App';
import { Logo } from './Logo';

export function Header() {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/20 bg-white/55 backdrop-blur-xl transition-colors duration-300 dark:border-zinc-800/80 dark:bg-zinc-950/60">
      <div className="container mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
        <Logo />

        <p className="ui-font hidden text-[10px] tracking-[0.24em] text-zinc-500 lg:block dark:text-zinc-400">
          Moscow / Since 2018
        </p>

        <div className="flex items-center gap-2">
          <a
            href="#contact"
            className="ui-font hidden rounded-full border border-zinc-300 px-4 py-2 text-[10px] tracking-[0.2em] text-zinc-700 transition hover:border-zinc-500 hover:text-zinc-950 sm:inline-flex dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
          >
            Start Project
          </a>

          <button
            onClick={toggleTheme}
            className="rounded-full border border-zinc-300 p-2 text-zinc-700 transition hover:border-zinc-500 hover:text-zinc-950 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
            aria-label="Toggle theme"
          >
            {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
