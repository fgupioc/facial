import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';

import {
  CHALLENGE_TEXT,
  ChallengeDetector,
  ChallengeType,
  createDetector,
  randomChallenges,
} from './challenges';
import { EvidenceRecorder } from './evidence-recorder';
import { FaceLandmarkerLoader } from './face-landmarker-loader';
import { FaceMetrics, ISSUE_HINTS, analyzeFace, isNeutral, measureBrightness } from './face-metrics';
import { ChallengeEvidence, FaceCaptureError, FaceCaptureErrorCode, FaceCaptureResult } from './models';

type Phase = 'loading' | 'positioning' | 'challenge' | 'final' | 'processing' | 'done' | 'error';

/** Tiempo que el rostro debe mantenerse bien ubicado antes de empezar. */
const STABLE_MS = 800;
/** Tiempo de mirada fija y neutra para la selfie final. */
const FINAL_STABLE_MS = 700;
/** Tiempo máximo para completar cada reto. */
const CHALLENGE_TIMEOUT_MS = 10_000;
/** Intentos fallidos permitidos en toda la sesión. */
const MAX_FAILED_ATTEMPTS = 3;
/** Cada cuántos frames se mide el brillo (es la parte más costosa). */
const BRIGHTNESS_EVERY_N_FRAMES = 8;
const JPEG_QUALITY = 0.92;

@Component({
  selector: 'app-face-capture',
  templateUrl: './face-capture.html',
  styleUrl: './face-capture.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FaceCapture implements AfterViewInit, OnDestroy {
  /** Retos definidos por el servidor. Si es null se eligen al azar (solo desarrollo). */
  readonly challenges = input<ChallengeType[] | null>(null);
  readonly challengeCount = input(2);

  readonly completed = output<FaceCaptureResult>();
  readonly failed = output<FaceCaptureError>();

  private readonly loader = inject(FaceLandmarkerLoader);
  private readonly videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('video');

  protected readonly phase = signal<Phase>('loading');
  protected readonly message = signal('Preparando la cámara...');
  protected readonly hint = signal<string | null>(null);
  protected readonly faceOk = signal(false);
  protected readonly step = signal(0);
  protected readonly totalSteps = signal(0);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly steps = computed(() => Array.from({ length: this.totalSteps() }, (_, i) => i));
  protected readonly canRetry = computed(() => this.phase() === 'error' && this.retryable());
  private readonly retryable = signal(true);

  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private readonly recorder = new EvidenceRecorder();
  private probeCtx: CanvasRenderingContext2D | null = null;

  private destroyed = false;
  private busy = false;
  private frameHandle: number | null = null;
  private lastTimestamp = 0;
  private frameCount = 0;
  private brightness = 128;
  private stableSince: number | null = null;

  private plan: ChallengeType[] = [];
  private challengeIndex = 0;
  private detector: ChallengeDetector | null = null;
  private deadline = 0;
  private failedAttempts = 0;
  private challengesStartedAt = 0;
  private startedAt = '';
  private neutralFrame: Blob | null = null;
  private evidence: ChallengeEvidence[] = [];

  private get video(): HTMLVideoElement {
    return this.videoRef().nativeElement;
  }

  ngAfterViewInit(): void {
    void this.start();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cancelFrame();
    this.recorder.abort();
    this.stopCamera();
  }

  protected retry(): void {
    this.failedAttempts = 0;
    this.errorMessage.set(null);
    void this.start();
  }

  // ---------------------------------------------------------------- inicio

  private async start(): Promise<void> {
    this.resetSession();
    this.phase.set('loading');
    this.message.set('Preparando la cámara...');
    this.hint.set(null);

    if (!window.isSecureContext) {
      return this.fail('insecure-context', 'La cámara solo funciona en una conexión segura (HTTPS).', false);
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return this.fail('camera-unsupported', 'Este navegador no permite usar la cámara.', false);
    }

    try {
      const [landmarker, stream] = await Promise.all([
        this.loader.get().catch((e) => {
          throw Object.assign(new Error('model'), { cause: e, model: true });
        }),
        this.stream ?? this.openCamera(),
      ]);
      if (this.destroyed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.landmarker = landmarker;
      this.stream = stream;

      const video = this.video;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      this.probeCtx = this.createProbeContext();
      this.phase.set('positioning');
      this.message.set('Ubica tu rostro dentro del óvalo');
      this.scheduleFrame();
    } catch (err) {
      this.handleStartError(err);
    }
  }

  private openCamera(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
  }

  private handleStartError(err: unknown): void {
    if (err && typeof err === 'object' && 'model' in err) {
      return this.fail('model-load-failed', 'No se pudo cargar el detector facial. Revisa tu conexión.');
    }
    const name = err instanceof DOMException ? err.name : '';
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return this.fail(
          'permission-denied',
          'Necesitamos permiso para usar la cámara. Actívalo en la configuración del navegador.',
        );
      case 'NotFoundError':
      case 'OverconstrainedError':
        return this.fail('camera-not-found', 'No encontramos una cámara en este dispositivo.');
      case 'NotReadableError':
      case 'AbortError':
        return this.fail('camera-busy', 'La cámara está siendo usada por otra aplicación.');
      default:
        console.error(err);
        return this.fail('unknown', 'Ocurrió un error al iniciar la cámara.');
    }
  }

  // ---------------------------------------------------------------- bucle de frames

  private scheduleFrame(): void {
    if (this.destroyed) return;
    const video = this.video;
    this.frameHandle =
      'requestVideoFrameCallback' in video
        ? video.requestVideoFrameCallback(() => this.onFrame())
        : requestAnimationFrame(() => this.onFrame());
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return;
    const video = this.videoRef()?.nativeElement;
    if (video && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private onFrame(): void {
    this.frameHandle = null;
    const phase = this.phase();
    if (this.destroyed || !this.landmarker || phase === 'done' || phase === 'error' || phase === 'loading') {
      return;
    }

    const video = this.video;
    if (!this.busy && video.readyState >= 2 && video.videoWidth > 0) {
      const now = performance.now();
      // MediaPipe exige timestamps estrictamente crecientes.
      const ts = Math.max(now, this.lastTimestamp + 1);
      this.lastTimestamp = ts;

      const result = this.landmarker.detectForVideo(video, ts);
      if (this.probeCtx && this.frameCount++ % BRIGHTNESS_EVERY_N_FRAMES === 0) {
        this.brightness = measureBrightness(video, this.probeCtx);
      }
      const metrics = analyzeFace(result, video.videoWidth, video.videoHeight, this.brightness);
      this.handleMetrics(metrics, now);
    }
    this.scheduleFrame();
  }

  private handleMetrics(m: FaceMetrics, now: number): void {
    switch (this.phase()) {
      case 'positioning':
        return this.handlePositioning(m, now);
      case 'challenge':
        return this.handleChallenge(m, now);
      case 'final':
        return this.handleFinal(m, now);
    }
  }

  // ---------------------------------------------------------------- fases

  private handlePositioning(m: FaceMetrics, now: number): void {
    const ok = m.issue === null;
    this.faceOk.set(ok);
    this.hint.set(ok ? 'No te muevas...' : ISSUE_HINTS[m.issue!]);
    if (!ok) {
      this.stableSince = null;
      return;
    }
    this.stableSince ??= now;
    if (now - this.stableSince >= STABLE_MS) void this.startChallenges();
  }

  private handleChallenge(m: FaceMetrics, now: number): void {
    if (m.faceCount !== 1) {
      // Si el rostro sale o aparece otra persona, el gesto en curso se invalida.
      this.faceOk.set(false);
      this.hint.set(ISSUE_HINTS[m.issue ?? 'no-face']);
      this.detector = createDetector(this.plan[this.challengeIndex]);
    } else {
      this.faceOk.set(true);
      this.hint.set(null);
      if (this.detector?.update(m)) {
        void this.completeChallenge();
        return;
      }
    }
    if (now > this.deadline) this.failChallenge();
  }

  private handleFinal(m: FaceMetrics, now: number): void {
    const ok = isNeutral(m);
    this.faceOk.set(ok);
    this.hint.set(ok ? 'No te muevas...' : m.issue ? ISSUE_HINTS[m.issue] : 'Mantén una expresión neutra');
    if (!ok) {
      this.stableSince = null;
      return;
    }
    this.stableSince ??= now;
    if (now - this.stableSince >= FINAL_STABLE_MS) void this.finish();
  }

  private async startChallenges(): Promise<void> {
    this.busy = true;
    try {
      this.neutralFrame = await this.captureFrame();
      this.plan = this.challenges() ?? randomChallenges(this.challengeCount());
      this.totalSteps.set(this.plan.length + 1);
      this.evidence = [];
      this.challengesStartedAt = performance.now();
      if (this.stream) this.recorder.start(this.stream);
      this.beginChallenge(0);
    } finally {
      this.busy = false;
    }
  }

  private beginChallenge(index: number): void {
    this.challengeIndex = index;
    this.detector = createDetector(this.plan[index]);
    this.deadline = performance.now() + CHALLENGE_TIMEOUT_MS;
    this.step.set(index);
    this.message.set(CHALLENGE_TEXT[this.plan[index]]);
    this.hint.set(null);
    this.phase.set('challenge');
  }

  private async completeChallenge(): Promise<void> {
    this.busy = true;
    try {
      const frame = await this.captureFrame();
      this.evidence.push({
        type: this.plan[this.challengeIndex],
        frame,
        completedAtMs: Math.round(performance.now() - this.challengesStartedAt),
      });
      const next = this.challengeIndex + 1;
      if (next < this.plan.length) {
        this.beginChallenge(next);
      } else {
        this.step.set(this.plan.length);
        this.stableSince = null;
        this.message.set('¡Mira fijamente a la cámara!');
        this.phase.set('final');
      }
    } finally {
      this.busy = false;
    }
  }

  private failChallenge(): void {
    this.failedAttempts++;
    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.recorder.abort();
      return this.fail('too-many-attempts', 'No pudimos validar los gestos. Inténtalo de nuevo.');
    }
    this.beginChallenge(this.challengeIndex);
    this.hint.set('No detectamos el gesto, intentemos otra vez');
  }

  private async finish(): Promise<void> {
    this.busy = true;
    this.phase.set('processing');
    this.message.set('Procesando...');
    this.hint.set(null);
    try {
      const selfie = await this.captureFrame();
      const video = await this.recorder.stop();
      const { videoWidth, videoHeight } = this.video;
      this.cancelFrame();
      this.stopCamera();

      this.phase.set('done');
      this.message.set('¡Listo! Captura completada');
      this.completed.emit({
        selfie,
        neutral: this.neutralFrame ?? selfie,
        challenges: this.evidence,
        video,
        videoMimeType: video?.type ?? null,
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        device: { userAgent: navigator.userAgent, videoWidth, videoHeight },
      });
    } catch (err) {
      console.error(err);
      this.fail('unknown', 'No se pudo completar la captura.');
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- utilidades

  /** Captura el frame original (sin espejo) en JPEG para enviarlo al servidor. */
  private captureFrame(): Promise<Blob> {
    const video = this.video;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen'))),
        'image/jpeg',
        JPEG_QUALITY,
      ),
    );
  }

  private createProbeContext(): CanvasRenderingContext2D | null {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    return canvas.getContext('2d', { willReadFrequently: true });
  }

  private resetSession(): void {
    this.cancelFrame();
    this.recorder.abort();
    this.busy = false;
    this.stableSince = null;
    this.plan = [];
    this.challengeIndex = 0;
    this.detector = null;
    this.evidence = [];
    this.neutralFrame = null;
    this.step.set(0);
    this.totalSteps.set(0);
    this.faceOk.set(false);
    this.startedAt = new Date().toISOString();
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const video = this.videoRef()?.nativeElement;
    if (video) video.srcObject = null;
  }

  private fail(code: FaceCaptureErrorCode, message: string, retryable = true): void {
    this.cancelFrame();
    if (code !== 'too-many-attempts') this.stopCamera();
    this.retryable.set(retryable);
    this.errorMessage.set(message);
    this.message.set('No se pudo completar');
    this.hint.set(null);
    this.phase.set('error');
    this.failed.emit({ code, message });
  }
}
