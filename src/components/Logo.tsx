import React from 'react';
import Vector from '../imports/Vector';

export function Logo() {
  return (
    <a href="#" className="group inline-flex items-center gap-3">
      <div className="h-7 w-14 text-zinc-900 transition-colors [--fill-0:currentColor] dark:text-zinc-100">
        <Vector />
      </div>
      <p className="ui-font text-[11px] tracking-[0.24em] text-zinc-900 dark:text-zinc-100">IMA Vision</p>
    </a>
  );
}
