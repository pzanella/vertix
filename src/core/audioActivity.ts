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
// Longest output delay the graph supports (lookahead never exceeds 600 ms).
const MAX_OUTPUT_DELAY_SEC = 1;
// Gain ramp around an output-delay change, so the jump is a short silence, not a click.
const MUTE_RAMP_SEC = 0.005;
// Exact digital silence for this long, while the element is playing
// unmuted and has decoded audio, reads as a tainted (cross-origin, no CORS)
// source rather than a quiet passage.
const SILENT_PATH_SUSPECT_MS = 3000;

export class AudioActivityMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private delay: DelayNode | null = null;
  private gain: GainNode | null = null;
  private outputDelay = 0;
  private exactSilenceSinceMs: number | null = null;
  private _silentPathSuspected = false;
  private sourceVideo: HTMLVideoElement | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private data: Uint8Array | null = null;
  private _available = false;

  get available(): boolean {
    return this._available;
  }

  /** Seconds the element's audio is delayed by on its way to the speakers. */
  get outputDelaySec(): number {
    return this.outputDelay;
  }

  /** True while the graph seems to carry only exact silence although the element is playing audio: see checkSilentPath. */
  get silentPathSuspected(): boolean {
    return this._silentPathSuspected;
  }

  /**
   * Attaches to a video element. A no-op if already attached to this exact
   * element — the browser allows only one MediaElementAudioSourceNode per
   * element for its entire lifetime (a second attempt throws), so this
   * guards against that rather than re-creating anything.
   *
   * Routes source -> analyser -> delay -> gain -> destination (not just
   * source -> analyser): creating a MediaElementAudioSourceNode redirects
   * the element's audio output into the Web Audio graph, so skipping the
   * destination hop would silence normal playback — breaking this app's
   * own mute toggle — even though nothing about that toggle changed. The
   * analyser sits before the delay, so energy() still reads the audio of
   * the frame being decoded; the delay holds the audio back as long as the
   * lookahead holds the video back.
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
      // No smoothingTimeConstant: it only smooths frequency-domain data, and
      // energy() reads time-domain samples.
      this.delay = this.ctx.createDelay(MAX_OUTPUT_DELAY_SEC);
      this.delay.delayTime.value = this.outputDelay;
      this.gain = this.ctx.createGain();
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.delay);
      this.delay.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.ctx.addEventListener("statechange", this.onStateChange);
      this.data = new Uint8Array(this.analyser.fftSize);
      this._available = true;
      video.addEventListener("play", this.resumeIfSuspended);
      video.addEventListener("volumechange", this.resumeIfSuspended);
    } catch {
      // No audio track, an already-tapped element, or anything else the
      // browser objects to — degrade to unavailable, never surface an error.
      this._available = false;
    }
  }

  /**
   * The context is created from an effect, outside any user gesture, so the
   * browser may start it suspended — and since the element's audio flows
   * only through this graph, a suspended context means silent playback even
   * while unmuted. Retried on every play/unmute, which usually carry a gesture.
   */
  private resumeIfSuspended = (): void => {
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
  };

  /** A context resumed after a suspension may still hold old audio in the delay line: silence it out. */
  private onStateChange = (): void => {
    if (this.ctx?.state === "running" && this.outputDelay > 0) this.muteFor(this.outputDelay);
  };

  /**
   * Changes the output delay without replaying or clicking: the output
   * fades out, the delay changes, and the output stays silent until audio
   * that entered after the change comes out (`seconds` later).
   */
  setOutputDelay(seconds: number): void {
    const delaySec = Math.min(MAX_OUTPUT_DELAY_SEC, Math.max(0, seconds));
    if (delaySec === this.outputDelay) return;
    this.outputDelay = delaySec;
    if (!this.ctx || !this.delay) return;
    this.muteFor(delaySec, () => {
      this.delay!.delayTime.setValueAtTime(delaySec, this.ctx!.currentTime + MUTE_RAMP_SEC);
    });
  }

  /** Silences the output for `seconds` (plus short ramps), e.g. while the delay line still holds audio from before a seek. */
  muteFor(seconds: number, whileSilent?: () => void): void {
    const ctx = this.ctx;
    const gain = this.gain?.gain;
    if (!ctx || !gain) return;
    const t = ctx.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(0, t + MUTE_RAMP_SEC);
    whileSilent?.();
    gain.setValueAtTime(0, t + MUTE_RAMP_SEC + seconds);
    gain.linearRampToValueAtTime(1, t + 2 * MUTE_RAMP_SEC + seconds);
  }

  /**
   * Updates silentPathSuspected. A cross-origin source without CORS
   * headers plays through the graph as exact zeros instead of failing, so
   * delaying it is pointless and the caller should not rely on the graph.
   * Only judged while `video` plays unmuted and reports decoded audio, so a
   * clip without an audio track never counts. Cleared by any non-zero sample.
   */
  checkSilentPath(video: HTMLVideoElement, nowMs: number): boolean {
    if (!this._available || !this.analyser || !this.data) return this._silentPathSuspected;
    const audible = !video.paused && !video.muted && video.volume > 0;
    if (!audible || !hasDecodedAudio(video)) {
      this.exactSilenceSinceMs = null;
      return this._silentPathSuspected;
    }
    this.analyser.getByteTimeDomainData(this.data);
    const exactSilence = this.data.every((v) => v === 128);
    if (!exactSilence) {
      this.exactSilenceSinceMs = null;
      this._silentPathSuspected = false;
    } else {
      this.exactSilenceSinceMs ??= nowMs;
      if (nowMs - this.exactSilenceSinceMs >= SILENT_PATH_SUSPECT_MS) this._silentPathSuspected = true;
    }
    return this._silentPathSuspected;
  }

  detach(): void {
    this.sourceVideo?.removeEventListener("play", this.resumeIfSuspended);
    this.sourceVideo?.removeEventListener("volumechange", this.resumeIfSuspended);
    this.ctx?.removeEventListener("statechange", this.onStateChange);
    this.sourceNode?.disconnect();
    this.analyser?.disconnect();
    this.delay?.disconnect();
    this.gain?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.delay = null;
    this.gain = null;
    this.exactSilenceSinceMs = null;
    this._silentPathSuspected = false;
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

/** Whether the element has decoded any audio, from whichever non-standard counter this browser has. Unknown counts as no. */
function hasDecodedAudio(video: HTMLVideoElement): boolean {
  const v = video as HTMLVideoElement & {
    webkitAudioDecodedByteCount?: number;
    mozHasAudio?: boolean;
    audioTracks?: { length: number };
  };
  if (typeof v.webkitAudioDecodedByteCount === "number") return v.webkitAudioDecodedByteCount > 0;
  if (typeof v.mozHasAudio === "boolean") return v.mozHasAudio;
  return (v.audioTracks?.length ?? 0) > 0;
}
