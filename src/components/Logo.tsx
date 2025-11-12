import React from 'react';
import Vector from '../imports/Vector';

export function Logo() {
  return (
    <a href="#" className="flex items-center gap-3 group">
      {/* Logo Icon */}
      <div className="h-8 w-16 text-zinc-900 dark:text-zinc-100 transition-colors [--fill-0:currentColor]">
        <Vector />
      </div>
      
      {/* Logo Text */}
      <span className="tracking-tight transition-colors">Images Models Animations</span>
    </a>
  );
}
