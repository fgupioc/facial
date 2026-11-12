import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { FaceCapture } from '../face-capture/face-capture';
import { parseChallenges } from '../face-capture/challenges';
import { FaceCaptureError, FaceCaptureResult } from '../face-capture/models';
import { CaptureApi } from './capture-api';

type Status = 'capturing' | 'uploading' | 'sent' | 'preview' | 'error';

interface Preview {
  label: string;
  url: string;
  kind: 'image' | 'video';
}

/**
 * Página que se carga dentro del iframe:
 *   /s/{sessionId}?ch=smile,blink&origin=https://app-cliente.pe
 *  - ch:     retos definidos por el servidor (opcional)
 *  - origin: origen de la app que embebe, para avisarle por postMessage
 */
@Component({
  selector: 'app-capture-page',
  imports: [FaceCapture],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      @if (status() === 'capturing' || status() === 'uploading') {
        <app-face-capture
          [challenges]="challenges"
          (completed)="onCompleted($event)"
          (failed)="onFailed($event)"
        />
        @if (status() === 'uploading') {
          <p class="msg">Enviando verificación...</p>
        }
      } @else if (status() === 'sent') {
        <p class="msg ok">Tu verificación se envió correctamente.</p>
      } @else if (status() === 'error') {
        <p class="msg">{{ error() }}</p>
        <button type="button" (click)="reset()">Volver a intentar</button>
      } @else {
        <h2>Vista previa (modo desarrollo)</h2>
        <div class="grid">
          @for (p of previews(); track p.url) {
            <figure>
              @if (p.kind === 'image') {
                <img [src]="p.url" [alt]="p.label" />
              } @else {
                <video [src]="p.url" controls playsinline></video>
              }
              <figcaption>{{ p.label }}</figcaption>
            </figure>
          }
        </div>
        <button type="button" (click)="reset()">Capturar de nuevo</button>
      }
    </main>
  `,
  styles: `
    .page { padding: 16px; font-family: system-ui, sans-serif; text-align: center; }
    .msg { margin-top: 16px; font-size: 1.05rem; }
    .ok { color: #16a34a; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    figure { margin: 0; }
    img, video { width: 100%; border-radius: 8px; background: #000; }
    figcaption { font-size: 0.85rem; color: #475569; }
    button { margin-top: 16px; padding: 10px 24px; border: 0; border-radius: 8px;
             background: #2563eb; color: #fff; font-size: 1rem; cursor: pointer; }
  `,
})
export class CapturePage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(CaptureApi);

  private readonly sessionId = this.route.snapshot.paramMap.get('sessionId');
  private readonly parentOrigin = this.route.snapshot.queryParamMap.get('origin');
  protected readonly challenges = parseChallenges(this.route.snapshot.queryParamMap.get('ch'));

  protected readonly status = signal<Status>('capturing');
  protected readonly previews = signal<Preview[]>([]);
  protected readonly error = signal<string | null>(null);

  async onCompleted(result: FaceCaptureResult): Promise<void> {
    if (!this.sessionId || !this.api.enabled) {
      this.showPreview(result);
      return;
    }
    this.status.set('uploading');
    try {
      await this.api.upload(this.sessionId, result);
      this.status.set('sent');
      this.notifyParent('face-capture:completed');
    } catch (err) {
      console.error(err);
      this.error.set('No se pudo enviar la verificación. Revisa tu conexión.');
      this.status.set('error');
      this.notifyParent('face-capture:error', { code: 'upload-failed' });
    }
  }

  onFailed(err: FaceCaptureError): void {
    this.notifyParent('face-capture:error', { code: err.code });
  }

  reset(): void {
    this.revokePreviews();
    this.error.set(null);
    this.status.set('capturing');
  }

  ngOnDestroy(): void {
    this.revokePreviews();
  }

  private showPreview(r: FaceCaptureResult): void {
    const list: Preview[] = [
      { label: 'Selfie final', url: URL.createObjectURL(r.selfie), kind: 'image' },
      { label: 'Foto inicial', url: URL.createObjectURL(r.neutral), kind: 'image' },
      ...r.challenges.map((c) => ({
        label: `Reto: ${c.type} (${c.completedAtMs} ms)`,
        url: URL.createObjectURL(c.frame),
        kind: 'image' as const,
      })),
    ];
    if (r.video) list.push({ label: 'Video de evidencia', url: URL.createObjectURL(r.video), kind: 'video' });
    this.previews.set(list);
    this.status.set('preview');
    console.log('Resultado de captura', r);
  }

  private revokePreviews(): void {
    this.previews().forEach((p) => URL.revokeObjectURL(p.url));
    this.previews.set([]);
  }

  /**
   * Avisa a la app que embebe solo para cerrar el modal o actualizar la UI.
   * El resultado real se consulta SIEMPRE desde el backend: este mensaje se puede falsificar.
   */
  private notifyParent(type: string, extra: Record<string, unknown> = {}): void {
    if (window.parent === window || !this.parentOrigin) return;
    window.parent.postMessage({ type, sessionId: this.sessionId, ...extra }, this.parentOrigin);
  }
}
