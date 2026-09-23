/**
 * Best-effort voice-activity signal read from a <video>'s own audio track,
 * via the Web Audio API. Purely additive: every caller must work correctly
 * with `available` false, since this fails silently (never throws) in any
 * of several ordinary situations —
 *
 * - the source has no audio track at all (every bundled sample clip: see
 *   src/components/Player/SamplePicker.tsx)
 * - AudioContext isn't available (very old browsers) or is blocked until a
 *   user gesture — by the time this attaches, playback has already started
 *   from one, so that's not expected in practice here, but isn't assumed
 * - the source is cross-origin without CORS headers, which taints the
 *   audio graph: getByteTimeDomainData then returns all-zero samples
 *   instead of throwing. This reads identically to real silence, which is
 *   fine — the layout fallback this feeds treats "can't tell who's
 *   talking" the same way regardless of *why* it can't tell.
 */
export class AudioActivityMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceVideo: HTMLVideoElement | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private data: Uint8Array | null = null;
  private _available = false;

  get available(): boolean {
    return this._available;
  }

  /**
   * Attaches to a video element. A no-op if already attached to this exact
   * element — the browser allows only one MediaElementAudioSourceNode per
   * element for its entire lifetime (a second attempt throws), so this
   * guards against that rather than re-creating anything.
   *
   * Routes source -> analyser -> destination (not just source -> analyser):
   * creating a MediaElementAudioSourceNode redirects the element's audio
   * output into the Web Audio graph, so skipping the destination hop would
   * silence normal playback — breaking this app's own mute toggle — even
   * though nothing about that toggle changed.
   */
  attach(video: HTMLVideoElement): void {
    if (this.sourceVideo === video) return;
    this.detach();
    this.sourceVideo = video;

    try {
      const AudioCtxCtor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxCtor) return;

      this.ctx = new AudioCtxCtor();
      this.sourceNode = this.ctx.createMediaElementSource(video);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.data = new Uint8Array(this.analyser.fftSize);
      this._available = true;
    } catch {
      // No audio track, an already-tapped element, or anything else the
      // browser objects to — degrade to unavailable, never surface an error.
      this._available = false;
    }
  }

  detach(): void {
    this.sourceNode?.disconnect();
    this.analyser?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.sourceVideo = null;
    this.data = null;
    this._available = false;
  }

  /** Current voice-activity energy (RMS of the time-domain signal), roughly
   * 0 (silence) to 1 (loud), or null if unavailable. Cheap enough to call
   * on every detection tick. */
  energy(): number | null {
    if (!this._available || !this.analyser || !this.data) return null;
    this.analyser.getByteTimeDomainData(this.data);
    let sumSquares = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / this.data.length);
  }
}
