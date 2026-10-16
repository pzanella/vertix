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
- **3 or more foreground faces**: the engine follows one main subject when one is clearly ahead
  (size, centre, stability, mouth activity), shows a grid only for a panel (3-4 similar faces
  still for 1 s), else frames the group if it fits in 9:16, else the largest face near the centre.
  Faces under 35% of the largest face's area are background and never change the layout.

| Clip | Faces | Expected framing |
|---|---|---|
| `1-speaker.mp4` — One speaker | 1 | Full 9:16 frame, chest-up crop, face anchored ~1/3 from the top (rule of thirds). Crop pans/zooms smoothly to follow him if he leans or shifts. |
| `2-speakers-a.mp4` — 2 speakers, example 1 (2 women walking outdoors) | 2 | Vertical top/bottom stack, one woman per pane. Since they're walking and turning, the crop should glide (not snap) as their positions drift, and not lose either face when they turn away from camera. Has real audio — confirm nothing changes with audio on. |
| `2-speakers-b.mp4` — 2 speakers, no audio, example 2 (office corridor, facing each other) | 2 | Same vertical stack. Good clip for checking the crop stays locked on each face through profile turns. |
| `2-speakers-c.mp4` — 2 speakers, no audio, example 3 (bar/counter) | 2 | Same vertical stack, tighter indoor framing. Crop shouldn't drift onto the countertop between the two faces. |
| `2-speakers-d.mp4` — 2 speakers, no audio, example 4 (couch conversation) | 2 | Same vertical stack. Closer, more static shot — good baseline for confirming panes stay stable when neither person moves much. |
| `3-speakers.mp4` — 3 speakers (meeting/interview, 3 at a table) | 3 | About 1 s on the person nearest the centre (no panel evidence yet), then the **3-pane grid** (2 top, 1 bottom) while nobody clearly leads, then a **single full-frame pane** on the woman in the middle from about 7.4 s, when she talks. Its audio track is silent, so the larger no-audio lead applies. |

## What to flag as a real bug (not expected behavior)

- Any pane showing a frozen/stale frame while others update.
- A pane's crop jumping (instantly or through a cross-dissolve) while the same person only moves
  within the shot — that should glide — or drifting onto empty background.
- Not a bug: the crop snapping to the new framing right after a hard cut in the source video
  (none of these samples has one; `node scripts/make-cut-clips.mjs` builds clips that do), or
  cross-dissolving to a new framing when the active speaker (3+ faces) switches to someone at
  least 0.15 of the frame away (`SWITCH_DISSOLVE_DISTANCE` in `tracking/layoutPlanner.ts`).
- For `3-speakers.mp4`: rapid flickering between single-speaker and grid layouts within a
  couple of seconds — the subject hold (`SUBJECT_HOLD_SEC` in `tracking/subjectSelector.ts`) is meant to prevent this.
- For `3-speakers.mp4`: the crop locking onto someone who isn't actually the speaker (a bystander,
  a mic-holder) and staying there — the exact failure that got the 2-face version of this reverted;
  watch for it here too since the same size-dominance check still runs at 3+.
- Console showing `[Vertix] Detection worker unavailable` under normal conditions.
- Analytics Dashboard's Face Confidence / Motion Activity staying at zero throughout playback.
