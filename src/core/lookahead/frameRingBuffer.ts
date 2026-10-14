/** A captured frame waiting to be displayed. */
export interface BufferedFrame<Slot> {
  slot: Slot;
  mediaTimeSec: number;
  /** performance.now() time at which the video element would have shown this frame (rVFC expectedDisplayTime). */
  presentedAtMs: number;
  /** Capture order since the source was loaded. */
  frameIndex: number;
  /** Not shown until released: a frame captured while paused (or on a mode switch) waiting for its own detection. */
  held: boolean;
  /** Released from held: shown at the next display, whatever its time. */
  forced: boolean;
}

/**
 * Pool of frame slots, used as a FIFO of captured frames waiting to be
 * displayed. Slots are reused; at most `maxSlots` exist. The limit can
 * change at any time without dropping waiting frames: a lower limit frees
 * slots as frames are released. If every slot is waiting, the oldest
 * waiting frame is dropped to make room (counted in `overflowDrops`).
 */
export class FrameRingBuffer<Slot> {
  private readonly free: Slot[] = [];
  private readonly queue: BufferedFrame<Slot>[] = [];
  private allocated = 0;
  private _maxSlots: number;
  private _overflowDrops = 0;
  private _skippedOnDisplay = 0;

  constructor(
    private readonly createSlot: () => Slot,
    maxSlots: number
  ) {
    this._maxSlots = maxSlots;
  }

  get maxSlots(): number {
    return this._maxSlots;
  }

  /** Frames waiting for display. */
  get length(): number {
    return this.queue.length;
  }

  /** Slots that exist right now (each holds one frame's pixels). */
  get allocatedSlots(): number {
    return this.allocated;
  }

  /** Frames dropped before display because the pool was full. */
  get overflowDrops(): number {
    return this._overflowDrops;
  }

  /** Frames passed over on display because a later frame was already due (a late display, or a shrinking delay). */
  get skippedOnDisplay(): number {
    return this._skippedOnDisplay;
  }

  /** Changes the pool limit; extra slots are freed now if idle, else when their frames are released. */
  setMaxSlots(maxSlots: number): void {
    this._maxSlots = Math.max(1, maxSlots);
    while (this.allocated > this._maxSlots && this.free.length > 0) {
      this.free.pop();
      this.allocated -= 1;
    }
  }

  /** A slot to capture the next frame into. Fill it, then `enqueue` it. */
  acquire(): Slot {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.allocated < this._maxSlots) {
      this.allocated += 1;
      return this.createSlot();
    }
    const oldest = this.queue.shift()!;
    this._overflowDrops += 1;
    return oldest.slot;
  }

  enqueue(frame: BufferedFrame<Slot>): void {
    this.queue.push(frame);
  }

  /**
   * The latest waiting frame for which `isDue` holds (or that was released
   * from held), removed from the queue; frames before it are released as
   * skipped. Null when none is due. Call `release` once it has been drawn.
   */
  takeLatest(isDue: (frame: BufferedFrame<Slot>) => boolean): BufferedFrame<Slot> | null {
    let index = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const frame = this.queue[i];
      if (frame.forced || (!frame.held && isDue(frame))) index = i;
    }
    if (index < 0) return null;
    const taken = this.queue.splice(0, index + 1);
    for (let i = 0; i < taken.length - 1; i++) this.release(taken[i]);
    this._skippedOnDisplay += taken.length - 1;
    return taken[taken.length - 1];
  }

  /** Whether a held frame is waiting. */
  get hasHeld(): boolean {
    return this.queue.some((f) => f.held);
  }

  /** Releases every held frame, to be shown at the next display. */
  releaseHeld(): void {
    for (const frame of this.queue) {
      if (frame.held) {
        frame.held = false;
        frame.forced = true;
      }
    }
  }

  release(frame: BufferedFrame<Slot>): void {
    if (this.allocated > this._maxSlots) this.allocated -= 1;
    else this.free.push(frame.slot);
  }

  /** The waiting frame with this media time, if it has not been displayed yet. */
  find(mediaTimeSec: number): BufferedFrame<Slot> | null {
    return this.queue.find((f) => f.mediaTimeSec === mediaTimeSec) ?? null;
  }

  /** Drops every waiting frame (seek, source change, lookahead switched). */
  flush(): void {
    for (const frame of this.queue.splice(0)) this.release(frame);
  }

  resetCounters(): void {
    this._overflowDrops = 0;
    this._skippedOnDisplay = 0;
  }
}
