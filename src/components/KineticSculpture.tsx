import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const ROWS = 15;
const COLS = 15;
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
  isDark,
}: { points: Point[]; params: WaveParams; materialColor: string; isDark: boolean }) {
  const materialVariants = 3;
  const meshRefs = useRef<Array<THREE.InstancedMesh | null>>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const scales = useMemo(
    () =>
      points.map(() => ({
        x: 0.5 + Math.random() * 8,
        y: 0.5 + Math.pow(Math.random(), 2) * 400,
        z: 0.5 + Math.random() * 8,
      })),
    [points]
  );
  const groupIndex = useMemo(() => {
    return points.map(() => {
      const r = Math.random();
      if (r < 0.8) return 0;      // 80% первый шейдер
      if (r < 0.9) return 1;      // 10% чекер
      return 2;                  // 10% вертикальный
    });
  }, [points]);
  const groups = useMemo(() => {
    const buckets: number[][] = Array.from({ length: materialVariants }, () => []);
    points.forEach((_, idx) => {
      buckets[groupIndex[idx]].push(idx);
    });
    return buckets;
  }, [groupIndex, materialVariants, points]);

  const materials = useMemo(() => {
    const base = new THREE.Color(materialColor);
    const highlight = base.clone().multiplyScalar(1.25);
    const fragmentStripe = `
      uniform vec3 colorA;
      uniform vec3 colorB;
      uniform float opacity;
      uniform float stripeFreq;
      uniform float stripeSpeed;
      uniform float time;
      uniform vec3 cameraPos;
      uniform float fadeDistance;
      uniform float stripeInvert; // 0: opaque dark, 1: opaque light
      uniform int stripeSolid;
      uniform int stripeAxis; // 0: Y, 1: X, 2: Z, 3: XZ
      varying float vY;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      uniform float stripeOffset;
      void main() {
        if (abs(vNormal.y) > 0.6) {
          discard;
        }
        float coord = stripeAxis == 1 ? vLocalPos.x : stripeAxis == 2 ? vLocalPos.z : stripeAxis == 3 ? 0.5 * (abs(vLocalPos.x) + abs(vLocalPos.z)) : vLocalPos.y;
        float stripePhase = fract((abs(coord) + stripeOffset) * stripeFreq + time * stripeSpeed);
        float stripe = smoothstep(0.45, 0.65, stripePhase);
        vec3 color = mix(colorA, colorB, stripe);
        float alpha = stripeSolid == 1 ? opacity : opacity * mix(stripe, 0.8 - stripe, stripeInvert);
        if (stripeSolid == 0) {
          float distFade = clamp(1.0 - length(vWorldPos - cameraPos) / fadeDistance, 0.0, 1.0);
          alpha *= distFade;
        }
        gl_FragColor = vec4(color, alpha);
      }
    `;

    const fragmentChecker = `
      uniform vec3 colorA;
      uniform vec3 colorB;
      uniform float opacity;
      uniform float stripeFreq;
      uniform float stripeSpeed;
      uniform float time;
      uniform vec3 cameraPos;
      uniform float fadeDistance;
      uniform vec3 checkerFreq;
      uniform float checkerOffset;
      varying float vY;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      uniform float stripeOffset;
      void main() {
        if (abs(vNormal.y) > 0.6) {
          discard;
        }
        float px = step(0.5, fract((vLocalPos.x + checkerOffset) * checkerFreq.x));
        float py = step(0.5, fract((vLocalPos.y + checkerOffset) * checkerFreq.y));
        float pz = step(0.5, fract((vLocalPos.z + checkerOffset) * checkerFreq.z));
        float checker = mod(px + py + pz, 2.0);
        vec3 color = mix(colorA, colorB, checker);
        float alpha = opacity * (0.6 - checker);
        float distFade = clamp(1.0 - length(vWorldPos - cameraPos) / fadeDistance, 0.0, 1.0);
        alpha *= distFade;
        gl_FragColor = vec4(color, alpha);
      }
    `;

    const makeMat = (
      contrast: number,
      opacity: number,
      pattern: 'stripe' | 'checker' = 'stripe',
      cfg?: {
        stripeFreq?: number;
        stripeOffset?: number;
        stripeSolid?: boolean;
        checkerFreq?: number;
        checkerFreqX?: number;
        checkerFreqY?: number;
        checkerFreqZ?: number;
        checkerOffset?: number;
      }
    ) =>
      new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        transparent: pattern === 'stripe' ? cfg?.stripeSolid !== true : true,
        blending:
          pattern === 'stripe'
            ? cfg?.stripeSolid === true
              ? THREE.NormalBlending
              : THREE.AdditiveBlending
            : THREE.AdditiveBlending,
        depthWrite: true,
        uniforms: {
          colorA: { value: highlight.clone().multiplyScalar(contrast) },
          colorB: { value: base.clone().multiplyScalar(contrast) },
          opacity: { value: opacity },
          stripeFreq: { value: cfg?.stripeFreq ?? 0.07 },
          stripeSpeed: { value: 0.0 },
          time: { value: 0 },
          cameraPos: { value: new THREE.Vector3() },
          fadeDistance: { value: 1400.0 },
          stripeOffset: { value: cfg?.stripeOffset ?? -10.5 },
          stripeInvert: { value: isDark ? 1.0 : 0.0 },
          stripeSolid: { value: cfg?.stripeSolid ? 1 : 0 },
          stripeAxis: {
            value:
              cfg?.stripeAxis === 'x'
                ? 1
                : cfg?.stripeAxis === 'z'
                  ? 2
                  : cfg?.stripeAxis === 'xz'
                    ? 3
                    : 0,
          },
          checkerFreq: {
            value: new THREE.Vector3(
              cfg?.checkerFreqX ?? cfg?.checkerFreq ?? 0.01,
              cfg?.checkerFreqY ?? cfg?.checkerFreq ?? 0.01,
              cfg?.checkerFreqZ ?? cfg?.checkerFreq ?? 0.08
            ),
          },
          checkerOffset: { value: 0.5 }
        },
        vertexShader: `
      varying float vY;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      void main() {
        vec3 scaledPos = (instanceMatrix * vec4(position, 0.0)).xyz;
        vLocalPos = scaledPos;
        vY = scaledPos.y;
        vec4 worldPos = instanceMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * worldPos;
      }
        `,
        fragmentShader: pattern === 'checker' ? fragmentChecker : fragmentStripe,
      });

    return [
      makeMat(1.0, 0.85, 'stripe', { stripeFreq: 0.07, stripeOffset: -10.5, stripeSolid: false }),
      makeMat(0.9, 0.8, 'checker', {
        checkerFreq: 0.1,
        checkerFreqY: 0.01,
        checkerFreqZ: 0.1,
        checkerOffset: -5.0,
      }),
      makeMat(1.0, 0.85, 'stripe', { stripeFreq: 0.4, stripeOffset: -10.5, stripeSolid: false, stripeAxis: 'xz' })
    ];
  }, [isDark, materialColor]);

  useEffect(() => {
    if (!materials.length) return;
    const base = new THREE.Color(materialColor);
    const highlight = base.clone().multiplyScalar(1.25);
    materials.forEach((mat, idx) => {
      const contrast = idx === 1 ? 0.75 : idx === 2 ? 1.2 : 1;
      mat.uniforms.colorA.value = highlight.clone().multiplyScalar(contrast);
      mat.uniforms.colorB.value = base.clone().multiplyScalar(contrast);
    });
  }, [materialColor, materials]);

  const { camera } = useThree();

  useFrame(({ clock }) => {
    const time = clock.elapsedTime * 1000;
    const { amplitude, frequency, rowPhase, colPhase } = params;
    const sinTilt = Math.sin(PLANE_TILT);
    const cosTilt = Math.cos(PLANE_TILT);
    materials.forEach((mat) => {
      mat.uniforms.time.value = time;
      mat.uniforms.cameraPos.value.copy(camera.position);
    });

    groups.forEach((indices, groupIdx) => {
      const mesh = meshRefs.current[groupIdx];
      if (!mesh) return;
      indices.forEach((pointIdx, localIdx) => {
        const point = points[pointIdx];
        const phase = (point.row * rowPhase + point.col * colPhase) * Math.PI;
        const wave = Math.sin(time * frequency + phase) * amplitude;

        const worldY = point.z * sinTilt + wave;
        const worldZ = point.z * cosTilt;

        dummy.position.set(point.x, worldY, -worldZ);
        const s = scales[pointIdx];
        if (s.y < 50) {
          dummy.scale.set(0, 0, 0);
        } else {
          dummy.scale.set(s.x, s.y, s.z);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(localIdx, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  });

  return (
    <>
      {groups.map((indices, idx) =>
        indices.length > 0 ? (
          <instancedMesh
            // eslint-disable-next-line react/no-array-index-key
            key={idx}
            ref={(el) => {
              meshRefs.current[idx] = el;
            }}
            args={[undefined, undefined, indices.length]}
          >
            <boxGeometry args={[12, 1, 8]} />
            <primitive object={materials[idx]} attach="material" />
          </instancedMesh>
        ) : null
      )}
    </>
  );
}

export function KineticSculpture() {
  const points = useMemo(() => createPoints(), []);
  const [amplitude, setAmplitude] = useState(200);
  const [frequency, setFrequency] = useState(0.0001);
  const [rowPhaseFactor, setRowPhaseFactor] = useState(0.3);
  const [colPhaseFactor, setColPhaseFactor] = useState(0.4);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [cameraPos, setCameraPos] = useState<[number, number, number]>([0, 520, 320]);
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
      style={{ minHeight: 400 }}
      aria-hidden="true"
    >
      <div className="relative mx-auto flex w-full max-w-6xl justify-center px-6 pt-10 pb-16">
        <div
          data-kinetic-wrapper
          className="relative w-full max-w-5xl rounded-3xl overflow-hidden"
        >
          <div className="h-[300px] sm:h-[420px] md:h-[440px] w-full">
            <Canvas
              className="h-full w-full"
              style={{ width: '100%', height: '100%' }}
              camera={{ position: cameraPos, near: 1, far: 10000, fov: 75 }}
              dpr={[1, 1.5]}
              gl={{ antialias: true }}
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
