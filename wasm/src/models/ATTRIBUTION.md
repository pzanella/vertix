# ultraface-slim-320.onnx

Source: [Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB)
(`models/onnx/version-slim-320.onnx`), MIT License.

A small pretrained face-detection model. Vertix uses it as-is (no
fine-tuning or retraining) to find faces in each frame.

- Input: `1x3x240x320` RGB, normalized `(pixel - 127) / 128`.
- Output: `scores [1,4420,2]` (background/face) and `boxes [1,4420,4]`
  (`x1,y1,x2,y2`, normalized 0-1). Needs confidence filtering + NMS.
