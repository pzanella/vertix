import { describe, expect, it } from "vitest";
import type { FaceTrack } from "./faceTracker";
import {
  clearLeader,
  leadFactor,
  scoreContext,
  SubjectSelector,
  subjectScore,
  type ScoredTrack,
} from "./subjectSelector";

function track(id: number, overrides: Partial<FaceTrack> = {}): FaceTrack {
  return {
    id,
    box: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2 },
    lastDetection: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, motion: 0, lowerFaceMotion: 0, confidence: 0.9 },
    vx: 0,
    vy: 0,
    hits: 10,
    confirmed: true,
    firstSeenSec: 0,
    lastSeenSec: 0,
    visible: true,
    mouthActivity: 0,
    lowerFaceMotion: 0,
    jitter: 0,
    foreground: true,
    ...overrides,
  };
}

const scored = (scores: Record<number, number>): ScoredTrack[] =>
  Object.entries(scores).map(([id, score]) => ({ track: track(Number(id)), score }));

describe("subjectScore", () => {
  it("ranks the talking face first among faces of the same size", () => {
    const tracks = [1, 2, 3].map((id) => track(id, { box: { cx: 0.2 + 0.3 * (id - 1), cy: 0.5, w: 0.2, h: 0.2 } }));
    tracks[2].mouthActivity = 6;
    tracks[0].mouthActivity = 1;
    const context = scoreContext(tracks, 0.1, 5);
    const scores = tracks.map((t) => ({ track: t, score: subjectScore(t, context) }));
    expect(clearLeader(scores)?.id).toBe(3);
  });

  it("does not give a clear lead from the centre position alone", () => {
    const tracks = [0.2, 0.5, 0.8].map((cx, i) => track(i + 1, { box: { cx, cy: 0.5, w: 0.2, h: 0.2 } }));
    const context = scoreContext(tracks, null, 5);
    expect(clearLeader(tracks.map((t) => ({ track: t, score: subjectScore(t, context) })))).toBeNull();
  });

  it("needs a larger lead without audio confirming speech", () => {
    expect(leadFactor(false)).toBeGreaterThan(leadFactor(true));
    expect(clearLeader(scored({ 1: 1.3, 2: 1 }), leadFactor(true))?.id).toBe(1);
    expect(clearLeader(scored({ 1: 1.3, 2: 1 }), leadFactor(false))).toBeNull();
  });

  it("ignores mouth activity when every face is below the noise floor", () => {
    const quiet = track(1, { mouthActivity: 0.3 });
    const still = track(2);
    const context = scoreContext([quiet, still], 0.1, 5);
    expect(subjectScore(quiet, context)).toBeCloseTo(subjectScore(still, context), 9);
  });
});

describe("SubjectSelector", () => {
  it("picks a clear leader at once when asked to (after a cut)", () => {
    const selector = new SubjectSelector();
    expect(selector.select(scored({ 1: 1, 2: 0.5, 3: 0.5 }), 0.2, true)).toBe(1);
  });

  it("otherwise waits until the leader has led for 0.8s", () => {
    const selector = new SubjectSelector();
    const picks = [0.2, 0.4, 0.6, 0.8, 1.0].map((t) => selector.select(scored({ 1: 1, 2: 0.5, 3: 0.5 }), t, false));
    expect(picks).toEqual([null, null, null, null, 1]);
  });

  it("picks nobody without a clear lead", () => {
    const selector = new SubjectSelector();
    expect(selector.select(scored({ 1: 1, 2: 0.9, 3: 0.5 }), 0.2, true)).toBeNull();
  });

  it("holds the subject for 2.5s, then switches after a clear lead held for 1.0s", () => {
    const selector = new SubjectSelector();
    selector.select(scored({ 1: 1, 2: 0.5, 3: 0.5 }), 0, true);
    const switchedAt: number[] = [];
    for (let t = 0.2; t <= 5; t = Math.round((t + 0.2) * 10) / 10) {
      if (selector.select(scored({ 1: 0.5, 2: 1, 3: 0.5 }), t, false) === 2) switchedAt.push(t);
    }
    // Held until 2.5s; the lead counts from the next detection (2.6s) and must last 1.0s.
    expect(switchedAt[0]).toBe(3.6);
  });

  it("does not switch when the challenger's lead is not held", () => {
    const selector = new SubjectSelector();
    selector.select(scored({ 1: 1, 2: 0.5 }), 0, true);
    let subject: number | null = 1;
    for (let i = 1; i <= 30; i++) {
      const challengerLeads = i % 4 !== 0;
      subject = selector.select(scored({ 1: 0.7, 2: challengerLeads ? 1 : 0.7 }), 2.5 + i * 0.2, false);
    }
    expect(subject).toBe(1);
  });

  it("picks again at once when the subject is gone", () => {
    const selector = new SubjectSelector();
    selector.select(scored({ 1: 1, 2: 0.5, 3: 0.5 }), 0, true);
    expect(selector.select(scored({ 2: 1, 3: 0.5 }), 0.2, false)).toBe(2);
  });
});
