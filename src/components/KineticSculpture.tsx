import React, { useEffect, useMemo, useRef, useState } from 'react';


const ROWS = 50;
const COLS = 50;
const GRID_WIDTH = 1100;
const GRID_DEPTH = 1600;
const CAMERA_HEIGHT = -250; // высота камеры над плоскостью
const CAMERA_OFFSET = 930; // расстояние от камеры до начала сетки
const PLANE_TILT = -0.4; // наклон плоскости пола

interface Point {
  x: number;
  z: number;
  row: number;
  col: number;
}

const createPoints = (): Point[] => {
  const nodes: Point[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const xNorm = col / (COLS - 1);
      const zNorm = row / (ROWS - 1);
      const x = (xNorm - 0.5) * GRID_WIDTH;
      const z = zNorm * GRID_DEPTH;
      nodes.push({ x, z, row, col });
    }
  }

  return nodes;
};

export function KineticSculpture() {
  const points = useMemo(() => createPoints(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const rafRef = useRef<number | null>(null);
  const [amplitude, setAmplitude] = useState(120);
  const [frequency, setFrequency] = useState(0.0001);
  const [rowPhaseFactor, setRowPhaseFactor] = useState(0.05);
  const [colPhaseFactor, setColPhaseFactor] = useState(0.07);
  const [controlsVisible, setControlsVisible] = useState(false);
  const amplitudeRef = useRef(amplitude);
  const frequencyRef = useRef(frequency);
  const rowPhaseRef = useRef(rowPhaseFactor);
  const colPhaseRef = useRef(colPhaseFactor);

  useEffect(() => {
    amplitudeRef.current = amplitude;
  }, [amplitude]);

  useEffect(() => {
    frequencyRef.current = frequency;
  }, [frequency]);

  useEffect(() => {
    rowPhaseRef.current = rowPhaseFactor;
  }, [rowPhaseFactor]);

  useEffect(() => {
    colPhaseRef.current = colPhaseFactor;
  }, [colPhaseFactor]);

  useEffect(() => {
    const handleHotkey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'l') {
        setControlsVisible(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const updateSize = () => {
      const wrapper = canvas.closest('[data-kinetic-wrapper]');
      const parent = wrapper instanceof HTMLElement ? wrapper : canvas.parentElement;
      if (!parent) return;

      const styles = window.getComputedStyle(parent);
      const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const width = parent.clientWidth - paddingX;
      const height = parent.clientHeight - paddingY;
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width, height, dpr };

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const render = (time: number) => {
      const { width, height } = sizeRef.current;
      if (!width || !height) return;

      ctx.clearRect(0, 0, width, height);

      const focalLength = Math.min(width, height) * 1.6;
      const horizon = height * 0.35;
      const sinTilt = Math.sin(PLANE_TILT);
      const cosTilt = Math.cos(PLANE_TILT);

      const sortedPoints = [...points].sort((a, b) => b.z - a.z);

      const freq = frequencyRef.current;
      const amp = amplitudeRef.current;
      const rowPhase = rowPhaseRef.current;
      const colPhase = colPhaseRef.current;

      sortedPoints.forEach(point => {
        const phase = (point.row * rowPhase + point.col * colPhase) * Math.PI;
        const wave = Math.sin(time * freq + phase) * amp;
        const worldY = point.z * sinTilt + wave;
        const worldZ = point.z * cosTilt;

        const Xc = point.x;
        const Yc = worldY - CAMERA_HEIGHT;
        const Zc = worldZ + CAMERA_OFFSET;
        if (Zc <= 0.1) return;

        const perspective = focalLength / Zc;
        const screenX = width / 2 + Xc * perspective;
        const screenY = horizon + Yc * perspective;
        const depthRatio = 1 - point.z / GRID_DEPTH;
        const radius = Math.max(0.1, 4 * perspective);

        const shadeBase = 230 - (point.z / GRID_DEPTH) * 90;
        const outerShade = Math.max(shadeBase - 120, 20);
        const gradient = ctx.createRadialGradient(
          screenX - radius * 0.35,
          screenY - radius * 0.35,
          radius * 0.2,
          screenX,
          screenY,
          radius
        );
        gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
        gradient.addColorStop(0.5, `rgba(${shadeBase}, ${shadeBase}, ${shadeBase}, 0.92)`);
        gradient.addColorStop(1, `rgba(${outerShade}, ${outerShade}, ${outerShade}, 0.85)`);

        ctx.beginPath();
        ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      });
    };

    const handleResize = () => {
      updateSize();
    };

    updateSize();
    const loop = (t: number) => {
      render(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [points]);

  return (
    <section
      className="relative overflow-hidden bg-white dark:bg-zinc-950 transition-colors duration-300"
      // style={{ minHeight: 20 }}
      aria-hidden="true"
    >
       <div className="relative mx-auto flex w-full max-w-6xl justify-center px-6 pt-24 pb-20">
        <div
          data-kinetic-wrapper
          className="relative w-full max-w-5xl rounded-3xl"
        >
          <div className="rounded-2xl bg-transparent">
            <canvas ref={canvasRef} className="block w-full aspect-[16/9] max-h-[280px] md:max-h-[320px] lg:max-h-[320px]."  />
          </div>

          {controlsVisible && (
            <div className="mt-6 flex flex-wrap items-center gap-6 justify-between text-sm">
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="120"
                  step="1"
                  value={amplitude}
                  onChange={(e) => setAmplitude(Number(e.target.value))}
                  className="slider"
                />
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.5"
                  value={frequency * 10000}
                  onChange={(e) => setFrequency(Number(e.target.value) / 10000)}
                  className="slider"
                />
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="0.5"
                  step="0.01"
                  value={rowPhaseFactor}
                  onChange={(e) => setRowPhaseFactor(Number(e.target.value))}
                  className="slider"
                />
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="0.5"
                  step="0.01"
                  value={colPhaseFactor}
                  onChange={(e) => setColPhaseFactor(Number(e.target.value))}
                  className="slider"
                />
              </label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
