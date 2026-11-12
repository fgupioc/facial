import { FaceMetrics, THRESHOLDS } from './face-metrics';

export type ChallengeType = 'smile' | 'blink' | 'turn-left' | 'turn-right';

export const ALL_CHALLENGES: readonly ChallengeType[] = ['smile', 'blink', 'turn-left', 'turn-right'];

export const CHALLENGE_TEXT: Record<ChallengeType, string> = {
  smile: 'Por favor, sonríe',
  blink: 'Parpadea lentamente',
  'turn-left': 'Gira la cabeza hacia tu izquierda',
  'turn-right': 'Gira la cabeza hacia tu derecha',
};

export interface ChallengeDetector {
  /** Devuelve true cuando el gesto se completó. */
  update(m: FaceMetrics): boolean;
}

/** Exige que una condición se mantenga N frames seguidos (evita falsos positivos). */
function holdFor(frames: number, condition: (m: FaceMetrics) => boolean): ChallengeDetector {
  let hold = 0;
  return {
    update(m) {
      hold = condition(m) ? hold + 1 : 0;
      return hold >= frames;
    },
  };
}

/** Parpadeo: ojos cerrados y luego abiertos de nuevo. */
function blinkDetector(): ChallengeDetector {
  let closed = false;
  return {
    update(m) {
      const t = THRESHOLDS;
      if (!closed) {
        closed = m.blinkLeft > t.blinkClosed && m.blinkRight > t.blinkClosed;
        return false;
      }
      return m.blinkLeft < t.blinkOpen && m.blinkRight < t.blinkOpen;
    },
  };
}

export function createDetector(type: ChallengeType): ChallengeDetector {
  switch (type) {
    case 'smile':
      return holdFor(4, (m) => m.smile > THRESHOLDS.smile);
    case 'blink':
      return blinkDetector();
    case 'turn-left':
      return holdFor(3, (m) => m.yaw > THRESHOLDS.turnLeftYaw);
    case 'turn-right':
      return holdFor(3, (m) => m.yaw < THRESHOLDS.turnRightYaw);
  }
}

/**
 * Selección aleatoria en el cliente, solo para desarrollo.
 * En producción el servidor debe generar los retos por sesión y luego verificarlos.
 */
export function randomChallenges(count: number): ChallengeType[] {
  const pool = [...ALL_CHALLENGES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length)));
}

export function parseChallenges(value: string | null): ChallengeType[] | null {
  if (!value) return null;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ChallengeType => (ALL_CHALLENGES as readonly string[]).includes(s));
  return list.length ? list : null;
}
