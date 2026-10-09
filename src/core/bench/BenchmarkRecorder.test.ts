import { describe, expect, it } from "vitest";
import { BenchmarkRecorder } from "./BenchmarkRecorder";

function fakeVideo(durationSec: number, playbackQuality = { dropped: 0, total: 0 }) {
  return {
    duration: durationSec,
    videoWidth: 1280,
    videoHeight: 720,
    muted: false,
    getVideoPlaybackQuality: () => ({
      droppedVideoFrames: playbackQuality.dropped,
      totalVideoFrames: playbackQuality.total,
    }),
  } as unknown as HTMLVideoElement;
}

describe("BenchmarkRecorder", () => {
  it("flags samples inside the warm-up window and excludes them from the summary", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 1, nominalFps: 25 });
    for (let i = 0; i < 50; i++) recorder.recordFrame(i * 40, i < 25 ? 100 : 2, i * 0.04, i);

    const result = recorder.finish("9:16");
    expect(result.raw.frames.warmup.filter((w) => w === 1)).toHaveLength(25);
    expect(result.summary.frameWorkMs.count).toBe(25);
    expect(result.summary.frameWorkMs.max).toBe(2);
    expect(result.summary.effectiveFps).toBeCloseTo(25);
  });

  it("estimates dropped frames from mediaTime and presentedFrames", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 0, nominalFps: 25 });
    // 2 s of 25 fps media time, but every 10th frame is never presented.
    let presented = 0;
    for (let frame = 0; frame <= 50; frame++) {
      if (frame % 10 === 5) continue;
      recorder.recordFrame(frame * 40, 1, frame * 0.04, presented);
      presented += 1;
    }

    const { frames } = recorder.finish("9:16").summary;
    expect(frames.expectedFrames).toBe(50);
    expect(frames.presentedFrames).toBe(45);
    expect(frames.droppedFramesEstimate).toBe(5);
    expect(frames.missedCallbacks).toBe(0);
    expect(frames.fpsSource).toBe("nominal");
  });

  it("counts presented frames that got no callback as missed callbacks", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 0, nominalFps: null });
    for (let i = 0; i <= 10; i++) recorder.recordFrame(i * 80, 1, i * 0.08, i * 2);

    const { frames } = recorder.finish("9:16").summary;
    expect(frames.presentedFrames).toBe(20);
    expect(frames.missedCallbacks).toBe(10);
    expect(frames.fpsSource).toBe("estimated");
    expect(frames.fpsUsed).toBeCloseTo(12.5);
  });

  it("summarizes detection stages, rate and skipped detections after warm-up", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 1, nominalFps: 25 });
    recorder.recordFrame(0, 1, 0, 0);
    recorder.recordDetection("worker", 50, 50, 500, 50, 700, 1, 1, 5, 5, 0, 0, 0, false);
    recorder.recordSkippedDetection();
    for (let i = 1; i <= 75; i++) {
      recorder.recordFrame(i * 40, 1, i * 0.04, i);
      if (i > 25 && i % 5 === 0)
        recorder.recordDetection("worker", 2, 3, 40, 1, 50, 2, 1, 2, 1, i / 25, 0.01, 0.02, false);
      if (i === 70) recorder.recordSkippedDetection();
    }

    const { detection } = recorder.finish("9:16").summary;
    expect(detection.count).toBe(10);
    expect(detection.skippedInFlight).toBe(1);
    expect(detection.workerCount).toBe(10);
    expect(detection.acquireMs.p50).toBe(5);
    expect(detection.overheadMs.p50).toBe(4);
    expect(detection.wasmMs.max).toBe(40);
    expect(detection.rateHz).toBeCloseTo(5);
    expect(detection.skinRejected).toEqual({ total: 20, speakerSized: 10 });
  });

  it("lists detected scene cuts with the analysed frame's media time and keeps every detection's scores", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 1, nominalFps: 25 });
    recorder.recordFrame(0, 1, 0, 0);
    recorder.recordDetection("worker", 2, 3, 40, 1, 50, 1, 1, 0, 0, 0, 0.5, 0.4, true);
    recorder.recordFrame(1200, 1, 1.2, 30);
    recorder.recordDetection("worker", 2, 3, 40, 1, 50, 1, 1, 0, 0, 1.0, 0.02, 0.03, false);
    recorder.recordDetection("worker", 2, 3, 40, 1, 50, 1, 1, 0, 0, 1.2, 0.3, 0.2, true);

    const { summary, raw } = recorder.finish("9:16");
    expect(summary.sceneCutCount).toBe(2);
    expect(summary.sceneCuts).toEqual([
      { mediaTimeSec: 0, histScore: 0.5, gridScore: 0.4, warmup: true },
      { mediaTimeSec: 1.2, histScore: 0.3, gridScore: 0.2, warmup: false },
    ]);
    expect(raw.detections.sceneCutHist).toEqual([0.5, 0.02, 0.3]);
    expect(raw.detections.sceneCutGrid).toEqual([0.4, 0.03, 0.2]);
    expect(raw.detections.sceneCut).toEqual([1, 0, 1]);
    expect(raw.detections.frameMediaTimeSec).toEqual([0, 1.0, 1.2]);
  });

  it("ignores samples recorded after finish", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 0, nominalFps: 25 });
    recorder.recordFrame(0, 1, 0, 0);
    recorder.finish("9:16");
    recorder.recordFrame(40, 1, 0.04, 1);
    expect(recorder.finish("9:16").raw.frames.nowMs).toHaveLength(1);
  });

  it("counts samples that overflow the preallocated buffers instead of growing them", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(0), warmupSec: 0, nominalFps: 25 });
    for (let i = 0; i < 300; i++) recorder.recordFrame(i, 1, i * 0.04, i);
    const result = recorder.finish("9:16");
    expect(result.raw.frames.nowMs).toHaveLength(256);
    expect(result.summary.overflow.frames).toBe(44);
  });

  it("counts duplicate callbacks for the same presented frame", () => {
    const recorder = new BenchmarkRecorder({ clipName: "a", video: fakeVideo(10), warmupSec: 0, nominalFps: 25 });
    for (let i = 0; i < 10; i++) {
      recorder.recordFrame(i * 40, 1, i * 0.04, i);
      recorder.recordFrame(i * 40 + 1, 1, i * 0.04, i);
    }
    expect(recorder.finish("9:16").summary.frames.duplicateCallbacks).toBe(10);
  });
});
