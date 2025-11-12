import { useEffect } from 'react';

export function SEOHead() {
  useEffect(() => {
    // Set the document title
    document.title = '3D АГР Модели для МКА, Архитектурная визуализация и анимация — Moscow AGR Compliant Studio';
    
    // Create or update meta tags
    const updateMetaTag = (name: string, content: string, isProperty = false) => {
      const attribute = isProperty ? 'property' : 'name';
      let meta = document.querySelector(`meta[${attribute}="${name}"]`);
      
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute(attribute, name);
        document.head.appendChild(meta);
      }
      
      meta.setAttribute('content', content);
    };

    // Standard meta tags
    updateMetaTag('description', 'Minimalist architectural visualization studio in Moscow specializing in 3D models, animation, and AGR-compliant digital architecture for Moskomarkhitektura.');
    updateMetaTag('keywords', 'architectural visualization Moscow, Moskomarkhitektura AGR 3D models, architectural animation, 3D rendering studio Russia, urban design visualization');
    
    // Open Graph tags
    updateMetaTag('og:title', '3D АГР Модели для МКА, Архитектурная визуализация и анимация — Moscow AGR Compliant Studio', true);
    updateMetaTag('og:description', 'Minimalist architectural visualization studio in Moscow specializing in 3D models, animation, and AGR-compliant digital architecture for Moskomarkhitektura.', true);
    updateMetaTag('og:type', 'website', true);
    
    // Additional meta tags
    updateMetaTag('viewport', 'width=device-width, initial-scale=1');
    updateMetaTag('charset', 'UTF-8');
    updateMetaTag('author', 'IMA Studio');
    updateMetaTag('language', 'Russian');
  }, []);

  return null;
}
