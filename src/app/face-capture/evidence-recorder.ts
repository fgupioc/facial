const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4', // Safari / iOS
];

/** Graba la secuencia de retos como evidencia para validarla en el servidor. */
export class EvidenceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  mimeType: string | null = null;

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined';
  }

  start(stream: MediaStream): void {
    if (!EvidenceRecorder.isSupported()) return;
    this.mimeType = CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(stream, {
        ...(this.mimeType ? { mimeType: this.mimeType } : {}),
        videoBitsPerSecond: 1_000_000,
      });
    } catch {
      this.recorder = null;
      return;
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(500);
  }

  stop(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = this.mimeType ?? rec.mimeType ?? 'video/webm';
        resolve(this.chunks.length ? new Blob(this.chunks, { type }) : null);
        this.recorder = null;
      };
      rec.stop();
    });
  }

  abort(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
  }
}
