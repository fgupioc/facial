import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { FaceCaptureResult } from '../face-capture/models';

/**
 * URL del backend (Spring Boot). Déjala vacía para trabajar solo con la vista previa,
 * sin enviar nada al servidor.
 */
export const CAPTURE_API_BASE_URL = '';

@Injectable({ providedIn: 'root' })
export class CaptureApi {
  private readonly http = inject(HttpClient);

  get enabled(): boolean {
    return CAPTURE_API_BASE_URL.length > 0;
  }

  /** Envía la evidencia como multipart/form-data a POST /sessions/{id}/face */
  upload(sessionId: string, r: FaceCaptureResult): Promise<unknown> {
    const form = new FormData();
    form.append('selfie', r.selfie, 'selfie.jpg');
    form.append('neutral', r.neutral, 'neutral.jpg');
    r.challenges.forEach((c, i) => form.append('challengeFrames', c.frame, `challenge_${i}_${c.type}.jpg`));
    if (r.video) {
      const ext = r.video.type.includes('mp4') ? 'mp4' : 'webm';
      form.append('video', r.video, `liveness.${ext}`);
    }
    const metadata = {
      challenges: r.challenges.map(({ type, completedAtMs }) => ({ type, completedAtMs })),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      device: r.device,
    };
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

    return firstValueFrom(
      this.http.post(`${CAPTURE_API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/face`, form),
    );
  }
}
