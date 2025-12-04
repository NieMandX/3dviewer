import React, { useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const ROWS = 50;
const COLS = 50;
const GRID_WIDTH =1000;
const GRID_DEPTH = 1000;
const PLANE_TILT = 0; // наклон плоскости пола

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

type WaveParams = {
  amplitude: number;
  frequency: number;
  rowPhase: number;
  colPhase: number;
};

function CameraRig({ position }: { position: [number, number, number] }) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(0, 300, 0);
    camera.updateProjectionMatrix();
  }, [camera, position]);

  return null;
}

function PointsField({
  points,
  params,
  materialColor,
}: { points: Point[]; params: WaveParams; materialColor: string }) {
  const meshRef = React.useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const scales = useMemo(
    () =>
      points.map(() => ({
        x: 4 + Math.random() * 4,
        y: 4 + (Math.random() * 10) * (Math.random() * 10),
        z: 4 + Math.random() * 4,
      })),
    [points]
  );

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const time = clock.elapsedTime * 1000;
    const { amplitude, frequency, rowPhase, colPhase } = params;
    const sinTilt = Math.sin(PLANE_TILT);
    const cosTilt = Math.cos(PLANE_TILT);

    points.forEach((point, i) => {
      const phase = (point.row * rowPhase + point.col * colPhase) * Math.PI;
      const wave = Math.sin(time * frequency + phase) * amplitude;

      const worldY = point.z * sinTilt + wave;
      const worldZ = point.z * cosTilt;

      dummy.position.set(point.x, worldY, -worldZ);
      const s = scales[i];
      dummy.scale.set(s.x, s.y, s.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, points.length]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial
        color={materialColor}
        transparent
        opacity={0.6}
        wireframe
      />
    </instancedMesh>
  );
}

export function KineticSculpture() {
  const points = useMemo(() => createPoints(), []);
  const [amplitude, setAmplitude] = useState(200);
  const [frequency, setFrequency] = useState(0.0001);
  const [rowPhaseFactor, setRowPhaseFactor] = useState(0.05);
  const [colPhaseFactor, setColPhaseFactor] = useState(0.06);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [cameraPos, setCameraPos] = useState<[number, number, number]>([0, 500, 200]);
  const [isDark, setIsDark] = useState(false);

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
    const updateTheme = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return (
    <section
      className="relative overflow-hidden bg-white dark:bg-zinc-950 transition-colors duration-300"
      style={{ minHeight: 520 }}
      aria-hidden="true"
    >
      <div className="relative mx-auto flex w-full max-w-6xl justify-center px-6 pt-24 pb-20">
        <div
          data-kinetic-wrapper
          className="relative w-full max-w-5xl rounded-3xl overflow-hidden"
        >
          <div className="h-[360px] sm:h-[420px] md:h-[480px] w-full">
            <Canvas
              className="h-full w-full"
              style={{ width: '100%', height: '100%' }}
              camera={{ position: cameraPos, near: 1, far: 10000, fov: 75 }}
              dpr={[1, 1.5]}
            >
              <CameraRig position={cameraPos} />
              <ambientLight intensity={0.8} />
              <directionalLight position={[200, 2000, 2000]} intensity={0.6} />
              <PointsField
                points={points}
                params={{
                  amplitude,
                  frequency,
                  rowPhase: rowPhaseFactor,
                  colPhase: colPhaseFactor,
                }}
                materialColor={isDark ? '#d8d8db' : '#0f0f0f'}
              />
            </Canvas>
          </div>

          {controlsVisible && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-6 text-sm">
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="250"
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
              <label className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Cam X</span>
                <input
                  type="range"
                  min="0"
                  max="5000"
                  step="10"
                  value={cameraPos[0]}
                  onChange={(e) => {
                    const x = Number(e.target.value);
                    setCameraPos(([_, y, z]) => [x, y, z]);
                  }}
                  className="slider"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Cam Y</span>
                <input
                  type="range"
                  min="0"
                  max="5000"
                  step="10"
                  value={cameraPos[1]}
                  onChange={(e) => {
                    const y = Number(e.target.value);
                    setCameraPos(([x, _, z]) => [x, y, z]);
                  }}
                  className="slider"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Cam Z</span>
                <input
                  type="range"
                  min="0"
                  max="5000"
                  step="10"
                  value={cameraPos[2]}
                  onChange={(e) => {
                    const z = Number(e.target.value);
                    setCameraPos(([x, y, _]) => [x, y, z]);
                  }}
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
