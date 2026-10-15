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

/** Creates slots at the current size and tells their sizes apart. */
export interface SlotAllocator<Slot> {
  /** A new slot at the current size. */
  create(): Slot;
  /** Bytes a slot created now would take. */
  bytesPerNewSlot(): number;
  bytesOf(slot: Slot): number;
  /** False for a slot of an earlier size: it is retired once released, when the budget allows a replacement. */
  isCurrent(slot: Slot): boolean;
}

/**
 * Pool of frame slots, used as a FIFO of captured frames waiting to be
 * displayed. Slots are created on demand and reused; at most `maxSlots`
 * slots of the current size exist, and all slots together, old sizes
 * included, stay within `budgetBytes`. The limit and the slot size can
 * change at any time: extra slots are freed as their frames are released,
 * and slots of an earlier size are retired the same way, each replaced by
 * one of the current size as the budget allows. If no slot can be had
 * within the budget, the oldest waiting frame is dropped to make room
 * (counted in `overflowDrops`).
 */
export class FrameRingBuffer<Slot> {
  private readonly free: Slot[] = [];
  private readonly queue: BufferedFrame<Slot>[] = [];
  private allocated = 0;
  private _allocatedBytes = 0;
  private _peakAllocatedBytes = 0;
  private _maxSlots: number;
  private _overflowDrops = 0;
  private _skippedOnDisplay = 0;

  constructor(
    private readonly allocator: SlotAllocator<Slot>,
    maxSlots: number,
    private readonly budgetBytes = Number.POSITIVE_INFINITY
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

  /** Bytes of the slots that exist right now. */
  get allocatedBytes(): number {
    return this._allocatedBytes;
  }

  /** Most bytes the slots ever took at once. */
  get peakAllocatedBytes(): number {
    return this._peakAllocatedBytes;
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
    this.retireIdleSlots();
  }

  /** A slot to capture the next frame into. Fill it, then `enqueue` it. */
  acquire(): Slot {
    this.retireIdleSlots();
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    const newBytes = this.allocator.bytesPerNewSlot();
    const currentCount = this.currentSlotCount();
    if (
      this.queue.length === 0 ||
      (currentCount < this._maxSlots && this._allocatedBytes + newBytes <= this.budgetBytes)
    ) {
      return this.allocate();
    }
    const { slot } = this.queue.shift()!;
    this._overflowDrops += 1;
    // The dropped frame's slot, swapped for one of the current size when the budget allows.
    const swappable =
      !this.allocator.isCurrent(slot) &&
      currentCount < this._maxSlots &&
      this._allocatedBytes - this.allocator.bytesOf(slot) + newBytes <= this.budgetBytes;
    if (!swappable) return slot;
    this.discard(slot);
    return this.allocate();
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
    return this.takeThrough(this.latestIndex(isDue));
  }

  /**
   * The frame to show for media time `dueSec`, taken like `takeLatest`:
   * the frame at that time (within a quarter frame) or a held frame just
   * released; else, with `catchUp` (the screen shows a frame from before
   * the due one, which the video element presented but whose frame
   * callback was skipped), the waiting frame nearest the due time, at most
   * one frame newer, the newer on a tie (audio leading the picture is the
   * more noticeable error); else the latest earlier frame, if any (a frame
   * the element dropped itself: held over, as the element does).
   */
  takeNearest(dueSec: number, intervalSec: number, catchUp: boolean): BufferedFrame<Slot> | null {
    const slackSec = intervalSec / 4;
    const older = this.latestIndex((f) => f.mediaTimeSec <= dueSec + slackSec);
    const olderFrame = older >= 0 ? this.queue[older] : null;
    if (olderFrame && (olderFrame.forced || olderFrame.mediaTimeSec >= dueSec - slackSec))
      return this.takeThrough(older);
    const newer = this.queue[older + 1];
    if (catchUp && newer && !newer.held && newer.mediaTimeSec <= dueSec + intervalSec + slackSec) {
      const newerIsNearer = !olderFrame || newer.mediaTimeSec - dueSec <= dueSec - olderFrame.mediaTimeSec + 1e-6;
      if (newerIsNearer) return this.takeThrough(older + 1);
    }
    return this.takeThrough(older);
  }

  private latestIndex(isDue: (frame: BufferedFrame<Slot>) => boolean): number {
    let index = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const frame = this.queue[i];
      if (frame.forced || (!frame.held && isDue(frame))) index = i;
    }
    return index;
  }

  private takeThrough(index: number): BufferedFrame<Slot> | null {
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
    const { slot } = frame;
    if (!this.allocator.isCurrent(slot) || this.currentSlotCount() > this._maxSlots) this.discard(slot);
    else this.free.push(slot);
  }

  /** Idle slots of an earlier size, or beyond the limit, are freed. */
  private retireIdleSlots(): void {
    for (let i = this.free.length - 1; i >= 0; i--) {
      if (!this.allocator.isCurrent(this.free[i])) this.discard(this.free.splice(i, 1)[0]);
    }
    while (this.free.length > 0 && this.allocated > this._maxSlots) this.discard(this.free.pop()!);
  }

  /** Slots of the current size (the ones `maxSlots` applies to). */
  private currentSlotCount(): number {
    let count = this.allocated;
    for (const frame of this.queue) if (!this.allocator.isCurrent(frame.slot)) count -= 1;
    return count;
  }

  private allocate(): Slot {
    this.allocated += 1;
    this._allocatedBytes += this.allocator.bytesPerNewSlot();
    this._peakAllocatedBytes = Math.max(this._peakAllocatedBytes, this._allocatedBytes);
    return this.allocator.create();
  }

  private discard(slot: Slot): void {
    this.allocated -= 1;
    this._allocatedBytes -= this.allocator.bytesOf(slot);
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
