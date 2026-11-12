import { Injectable } from '@angular/core';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';

/** Rutas servidas desde /public (ver la configuración de assets en angular.json). */
const WASM_PATH = 'mediapipe/wasm';
const MODEL_PATH = 'mediapipe/face_landmarker.task';

/**
 * Carga MediaPipe una sola vez y lo comparte.
 * Se importa de forma diferida para no inflar el bundle inicial.
 */
@Injectable({ providedIn: 'root' })
export class FaceLandmarkerLoader {
  private instance: Promise<FaceLandmarker> | null = null;

  get(): Promise<FaceLandmarker> {
    this.instance ??= this.create().catch((err) => {
      this.instance = null; // permite reintentar
      throw err;
    });
    return this.instance;
  }

  private async create(): Promise<FaceLandmarker> {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const base = document.baseURI;
    const fileset = await FilesetResolver.forVisionTasks(new URL(WASM_PATH, base).href);

    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: new URL(MODEL_PATH, base).href, delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 2, // 2 para poder detectar y rechazar si hay otra persona
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });

    try {
      return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      // Algunos navegadores o WebViews no tienen WebGL2: se usa la CPU.
      return FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
  }
}
