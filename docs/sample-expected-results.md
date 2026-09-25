# Sample clips — expected 9:16 result

Reference for manually checking each bundled sample (`public/samples/`) against what the
reframing algorithm is actually designed to do (`src/core/layoutEngine.ts`,
`resolveLayoutFaces` in `src/core/VertixEngine.ts`), not a guess at "looks nice". Use this to
tell a real regression apart from the algorithm doing exactly what it's supposed to.

Two facts that shape every row below:
- **1 or 2 faces**: always split into independent panes — 1 face fills the whole frame, 2 stack
  top/bottom. No active-speaker guessing at this count; a size-dominance version of that was
  tried and reverted (it locked onto a reporter's mic-holding arm instead of the actual speaker
  in real footage — see README's Known Limitations).
- **3 or more faces**: the engine first tries to resolve a single active speaker (by face size
  dominance, then by mouth motion if sizes are close) before falling back to the ordinary grid
  if it can't tell.

| Clip | Faces | Expected framing |
|---|---|---|
| `1-speaker.mp4` — One speaker | 1 | Full 9:16 frame, chest-up crop, face anchored ~1/3 from the top (rule of thirds). Crop pans/zooms smoothly to follow him if he leans or shifts. |
| `2-speakers-a.mp4` — 2 speakers, example 1 (2 women walking outdoors) | 2 | Vertical top/bottom stack, one woman per pane. Since they're walking and turning, the crop should glide (not snap) as their positions drift, and not lose either face when they turn away from camera. Has real audio — unmute to confirm nothing changes with audio on. |
| `2-speakers-b.mp4` — 2 speakers, no audio, example 2 (office corridor, facing each other) | 2 | Same vertical stack. Good clip for checking the crop stays locked on each face through profile turns. |
| `2-speakers-c.mp4` — 2 speakers, no audio, example 3 (bar/counter) | 2 | Same vertical stack, tighter indoor framing. Crop shouldn't drift onto the countertop between the two faces. |
| `2-speakers-d.mp4` — 2 speakers, no audio, example 4 (couch conversation) | 2 | Same vertical stack. Closer, more static shot — good baseline for confirming panes stay stable when neither person moves much. |
| `3-speakers.mp4` — 3 speakers (meeting/interview, 3 at a table) | 3 | If one person is clearly closer to camera/larger in frame, expect a **single full-frame pane** on them, switching if someone else becomes dominant. If no one's clearly foregrounded, expect the usual **3-pane grid** (2 top, 1 bottom). Has real audio — unmute to check it locks onto whoever's actually talking when sizes are close. |

## What to flag as a real bug (not expected behavior)

- Any pane showing a frozen/stale frame while others update.
- A pane's crop snapping instantly instead of gliding, or drifting onto empty background.
- For `3-speakers.mp4`: rapid flickering between single-speaker and grid layouts within a
  couple of seconds — the lock-in logic (`ACTIVE_SPEAKER_LOCK_TICKS`) is meant to prevent this.
- For `3-speakers.mp4`: the crop locking onto someone who isn't actually the speaker (a bystander,
  a mic-holder) and staying there — the exact failure that got the 2-face version of this reverted;
  watch for it here too since the same size-dominance check still runs at 3+.
- Console showing `[Vertix] Detection worker unavailable` under normal conditions.
- Analytics Dashboard's Face Confidence / Motion Activity staying at zero throughout playback.
