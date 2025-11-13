import React, { createContext, useContext, useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Navigation } from './components/Navigation';
import { HeroSection } from './components/HeroSection';
import { GallerySection } from './components/GallerySection';
import { ModelsSection } from './components/ModelsSection';
import { AboutSection } from './components/AboutSection';
import { ContactSection } from './components/ContactSection';
import { SEOHead } from './components/SEOHead';
import { KineticSculpture } from './components/KineticSculpture';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};

export default function App() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <SEOHead />
      <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors duration-300">
        <Header />
        <Navigation />
        <main>
          <KineticSculpture />
          <HeroSection />
          <GallerySection />
          <ModelsSection />
          <AboutSection />
          <ContactSection />
        </main>
        <footer className="border-t border-zinc-200 dark:border-zinc-800 py-12">
          <div className="container mx-auto px-6 max-w-7xl">
            <p className="text-center text-zinc-500 dark:text-zinc-400">
              © 2025 IMA Studio. Все права защищены.
            </p>
          </div>
        </footer>
      </div>
    </ThemeContext.Provider>
  );
}
