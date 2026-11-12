import type { Category, FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';

/** Índices de la malla facial de MediaPipe (478 puntos). */
const LM = {
  noseTip: 1,
  forehead: 10,
  chin: 152,
  cheekA: 234,
  cheekB: 454,
  eyeOuterA: 33,
  eyeOuterB: 263,
} as const;

/**
 * Umbrales ajustables. Calíbralos probando con varios usuarios y dispositivos.
 * - Tamaño y centro se miden respecto al lado menor del frame.
 * - yaw: 0.5 = de frente; sube cuando la persona gira a SU izquierda.
 */
export const THRESHOLDS = {
  minFaceSize: 0.4,
  maxFaceSize: 0.8,
  maxCenterOffset: 0.15,
  frontalYawMin: 0.4,
  frontalYawMax: 0.6,
  maxRollDeg: 12,
  minBrightness: 60,
  maxBrightness: 215,
  smile: 0.55,
  blinkClosed: 0.5,
  blinkOpen: 0.25,
  turnLeftYaw: 0.68,
  turnRightYaw: 0.32,
  neutralMaxSmile: 0.3,
  neutralMaxBlink: 0.4,
};

export type FaceIssue =
  | 'no-face'
  | 'multiple-faces'
  | 'too-dark'
  | 'too-bright'
  | 'too-far'
  | 'too-close'
  | 'off-center'
  | 'not-frontal';

export interface FaceMetrics {
  faceCount: number;
  /** Primer problema detectado, o null si el rostro está listo para capturar. */
  issue: FaceIssue | null;
  yaw: number;
  rollDeg: number;
  size: number;
  centerOffset: number;
  smile: number;
  blinkLeft: number;
  blinkRight: number;
  brightness: number;
}

export const ISSUE_HINTS: Record<FaceIssue, string> = {
  'no-face': 'No detectamos tu rostro',
  'multiple-faces': 'Solo debe haber una persona frente a la cámara',
  'too-dark': 'Busca un lugar con más luz',
  'too-bright': 'Hay demasiada luz, evita el contraluz',
  'too-far': 'Acércate un poco',
  'too-close': 'Aléjate un poco',
  'off-center': 'Centra tu rostro dentro del óvalo',
  'not-frontal': 'Mira de frente a la cámara',
};

const EMPTY: Omit<FaceMetrics, 'faceCount' | 'issue' | 'brightness'> = {
  yaw: 0.5,
  rollDeg: 0,
  size: 0,
  centerOffset: 1,
  smile: 0,
  blinkLeft: 0,
  blinkRight: 0,
};

export function analyzeFace(
  result: FaceLandmarkerResult,
  videoWidth: number,
  videoHeight: number,
  brightness: number,
): FaceMetrics {
  const faceCount = result.faceLandmarks.length;
  if (faceCount === 0) return { ...EMPTY, faceCount, brightness, issue: 'no-face' };
  if (faceCount > 1) return { ...EMPTY, faceCount, brightness, issue: 'multiple-faces' };

  const lm = result.faceLandmarks[0];
  const w = videoWidth;
  const h = videoHeight;
  const minDim = Math.min(w, h);

  // Giro horizontal (yaw): posición de la nariz entre las dos mejillas.
  const xa = lm[LM.cheekA].x * w;
  const xb = lm[LM.cheekB].x * w;
  const left = Math.min(xa, xb);
  const right = Math.max(xa, xb);
  const yaw = right - left > 1 ? (lm[LM.noseTip].x * w - left) / (right - left) : 0.5;

  // Inclinación lateral (roll): ángulo de la línea entre los ojos.
  const ea = lm[LM.eyeOuterA];
  const eb = lm[LM.eyeOuterB];
  const angle = (Math.atan2((eb.y - ea.y) * h, (eb.x - ea.x) * w) * 180) / Math.PI;
  const rollDeg = ((((angle + 90) % 180) + 180) % 180) - 90;

  // Tamaño y centrado.
  const size = ((lm[LM.chin].y - lm[LM.forehead].y) * h) / minDim;
  const { cx, cy } = centroid(lm);
  const centerOffset = Math.hypot(cx * w - w / 2, cy * h - h / 2) / minDim;

  const shapes = result.faceBlendshapes[0]?.categories ?? [];
  const smile = (score(shapes, 'mouthSmileLeft') + score(shapes, 'mouthSmileRight')) / 2;
  const blinkLeft = score(shapes, 'eyeBlinkLeft');
  const blinkRight = score(shapes, 'eyeBlinkRight');

  const t = THRESHOLDS;
  let issue: FaceIssue | null = null;
  if (brightness < t.minBrightness) issue = 'too-dark';
  else if (brightness > t.maxBrightness) issue = 'too-bright';
  else if (size < t.minFaceSize) issue = 'too-far';
  else if (size > t.maxFaceSize) issue = 'too-close';
  else if (centerOffset > t.maxCenterOffset) issue = 'off-center';
  else if (yaw < t.frontalYawMin || yaw > t.frontalYawMax || Math.abs(rollDeg) > t.maxRollDeg)
    issue = 'not-frontal';

  return { faceCount, issue, yaw, rollDeg, size, centerOffset, smile, blinkLeft, blinkRight, brightness };
}

export function isNeutral(m: FaceMetrics): boolean {
  return (
    m.issue === null &&
    m.smile < THRESHOLDS.neutralMaxSmile &&
    m.blinkLeft < THRESHOLDS.neutralMaxBlink &&
    m.blinkRight < THRESHOLDS.neutralMaxBlink
  );
}

/** Brillo promedio (0-255) usando una miniatura del frame para que sea barato. */
export function measureBrightness(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): number {
  const { width, height } = ctx.canvas;
  ctx.drawImage(video, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4);
}

function centroid(lm: NormalizedLandmark[]): { cx: number; cy: number } {
  let x = 0;
  let y = 0;
  for (const p of lm) {
    x += p.x;
    y += p.y;
  }
  return { cx: x / lm.length, cy: y / lm.length };
}

function score(categories: Category[], name: string): number {
  return categories.find((c) => c.categoryName === name)?.score ?? 0;
}
