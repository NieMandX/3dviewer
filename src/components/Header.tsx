import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../App';
import { Logo } from './Logo';

export function Header() {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800 transition-colors duration-300">
      <div className="container mx-auto px-6 py-4 max-w-7xl flex justify-between items-center text-sm">
        <div className="scale-[0.9] sm:scale-100 origin-left">
          <Logo />
        </div>
        
        <button
          onClick={toggleTheme}
          className="p-1.5 sm:p-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Toggle theme"
        >
          {theme === 'light' ? (
            <Moon className="w-4 h-4 sm:w-5 sm:h-5" />
          ) : (
            <Sun className="w-4 h-4 sm:w-5 sm:h-5" />
          )}
        </button>
      </div>
    </header>
  );
}
