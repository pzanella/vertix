/** A captured frame waiting to be displayed. */
export interface BufferedFrame<Slot> {
  slot: Slot;
  mediaTimeSec: number;
  /** performance.now() time at which the frame should be on screen. Infinity until set (a paused frame waiting for its detection). */
  dueMs: number;
  /** Capture order since the source was loaded. */
  frameIndex: number;
}

/**
 * Fixed pool of frame slots, used as a FIFO of captured frames waiting for
 * their display time. Slots are reused, never freed while the pool lives:
 * at most `maxSlots` exist. If every slot is waiting, the oldest waiting
 * frame is dropped to make room (counted in `overflowDrops`).
 */
export class FrameRingBuffer<Slot> {
  private readonly free: Slot[] = [];
  private readonly queue: BufferedFrame<Slot>[] = [];
  private allocated = 0;
  private _overflowDrops = 0;
  private _skippedOnDisplay = 0;

  constructor(
    private readonly createSlot: () => Slot,
    readonly maxSlots: number
  ) {}

  /** Frames waiting for display. */
  get length(): number {
    return this.queue.length;
  }

  /** Slots created so far (each holds one frame's pixels). */
  get allocatedSlots(): number {
    return this.allocated;
  }

  /** Frames dropped before display because the pool was full. */
  get overflowDrops(): number {
    return this._overflowDrops;
  }

  /** Frames that became due while a later frame was also due, so they were never shown (display loop too slow). */
  get skippedOnDisplay(): number {
    return this._skippedOnDisplay;
  }

  /** A slot to capture the next frame into. Fill it, then `enqueue` it. */
  acquire(): Slot {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.allocated < this.maxSlots) {
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
   * The latest waiting frame whose due time is at or before `nowMs`, removed
   * from the queue; earlier due frames are released as skipped. Null when
   * nothing is due. Call `release` with the frame once it has been drawn.
   */
  takeDue(nowMs: number): BufferedFrame<Slot> | null {
    let dueCount = 0;
    while (dueCount < this.queue.length && this.queue[dueCount].dueMs <= nowMs) dueCount += 1;
    if (dueCount === 0) return null;
    const taken = this.queue.splice(0, dueCount);
    for (let i = 0; i < taken.length - 1; i++) this.free.push(taken[i].slot);
    this._skippedOnDisplay += taken.length - 1;
    return taken[taken.length - 1];
  }

  /** Earliest due time among waiting frames, or null when empty. */
  nextDueMs(): number | null {
    return this.queue.length > 0 ? this.queue[0].dueMs : null;
  }

  release(frame: BufferedFrame<Slot>): void {
    this.free.push(frame.slot);
  }

  /** The waiting frame with this media time, if it has not been displayed yet. */
  find(mediaTimeSec: number): BufferedFrame<Slot> | null {
    return this.queue.find((f) => f.mediaTimeSec === mediaTimeSec) ?? null;
  }

  /** Makes every frame still held back (due Infinity) due at `nowMs`. */
  releaseHeld(nowMs: number): void {
    for (const frame of this.queue) if (frame.dueMs === Infinity) frame.dueMs = nowMs;
  }

  /** Drops every waiting frame (seek, source change, lookahead switched). */
  flush(): void {
    for (const frame of this.queue) this.free.push(frame.slot);
    this.queue.length = 0;
  }

  resetCounters(): void {
    this._overflowDrops = 0;
    this._skippedOnDisplay = 0;
  }
}
