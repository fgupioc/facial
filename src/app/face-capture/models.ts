import type { ChallengeType } from './challenges';

export interface ChallengeEvidence {
  type: ChallengeType;
  /** Frame capturado en el momento en que se detectó el gesto. */
  frame: Blob;
  /** Milisegundos desde el inicio de los retos. */
  completedAtMs: number;
}

export interface FaceCaptureResult {
  /** Foto final de frente y con expresión neutra: la que se compara con el documento. */
  selfie: Blob;
  /** Primera foto, tomada al quedar bien ubicado. */
  neutral: Blob;
  challenges: ChallengeEvidence[];
  /** Video de toda la secuencia de retos, para validarla en el servidor. */
  video: Blob | null;
  videoMimeType: string | null;
  startedAt: string;
  finishedAt: string;
  device: {
    userAgent: string;
    videoWidth: number;
    videoHeight: number;
  };
}

export type FaceCaptureErrorCode =
  | 'insecure-context'
  | 'camera-unsupported'
  | 'permission-denied'
  | 'camera-not-found'
  | 'camera-busy'
  | 'model-load-failed'
  | 'too-many-attempts'
  | 'unknown';

export interface FaceCaptureError {
  code: FaceCaptureErrorCode;
  message: string;
}
