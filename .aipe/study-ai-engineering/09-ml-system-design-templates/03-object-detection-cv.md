# Object detection (CV) system design

- **The prompt:** "Design a CV system that detects objects in real-time video, on-device."

- **Standard architecture:**

  ```
  Camera frame
    │
    ▼
  ┌──────────────────────────────────┐
  │ Preprocess                       │
  │  (resize, normalize, color cvt)  │
  └──────────────┬───────────────────┘
                 │  input tensor
                 ▼
  ┌──────────────────────────────────┐
  │ Detection model                  │
  │  (single-shot detector on-device)│
  └──────────────┬───────────────────┘
                 │  boxes + classes + scores
                 ▼
  ┌──────────────────────────────────┐
  │ Post-process                     │
  │  (NMS, smoothing, tracking)      │
  └──────────────┬───────────────────┘
                 │  stable tracks
                 ▼
  ┌──────────────────────────────────┐
  │ Downstream consumer              │
  │  (UI overlay, trigger, log)      │
  └──────────────────────────────────┘
  ```

- **Data model:**
  - Frame stream `{frame_id, timestamp, pixels}` — the video input.
  - Detection output `{frame_id, [boxes, classes, scores]}` — per-frame model output.
  - Track store `{track_id, box_history}` — temporal association of detections across frames.
  - Labeled training set — annotated frames `{image, [box, class]}` for training and eval.

- **Key components:**
  - *Preprocess*: resizes and normalizes frames to the model's input size. Decision: do it on the GPU/NPU to avoid CPU→accelerator copies per frame.
  - *Detection model*: a single-shot detector (YOLO/SSD-class) quantized for on-device latency. Decision: single-shot over two-stage (R-CNN) because real-time needs one forward pass per frame; INT8 quantization to fit the mobile NPU.
  - *Post-process*: non-max suppression dedups overlapping boxes; tracking smooths jitter across frames. Decision: a lightweight tracker (e.g. SORT) so a flickering single-frame miss doesn't drop the object.
  - *Downstream consumer*: overlays boxes, fires triggers, or logs. Decision: decouple from detection via a queue so a slow consumer never stalls the camera pipeline.

- **Scale concerns:**
  - At 30+ FPS real-time: per-frame inference latency is the hard wall. Solution: quantize, prune, run on the NPU; drop to keyframe detection + tracking between keyframes.
  - On-device memory: the model must fit the device budget. Solution: quantize to INT8, distill to a smaller backbone.
  - Battery / thermal: sustained inference throttles the device. Solution: adaptive frame rate, detect less often when the scene is static.

- **Eval framing:**
  - Offline: mAP at IoU thresholds (mAP@0.5, mAP@0.5:0.95) on a labeled test set; per-class precision/recall.
  - Online: on-device latency (p50/p99 ms/frame), FPS sustained, false-positive rate in the wild.
  - Domain shift matters: a model trained on daylight footage degrades at night; eval per condition, not just in aggregate.

- **Common failure modes:**
  - Domain shift → lighting/angle unseen in training tanks accuracy. Mitigation: augmentation, on-device fine-tuning, condition-stratified eval.
  - Quantization accuracy loss → INT8 drops mAP. Mitigation: quantization-aware training, not just post-training quantization.
  - Tracking drift / ID switches → boxes swap identities under occlusion. Mitigation: motion + appearance features in the tracker.

- **Applies to this codebase:** **no.** buffr has no camera, no image input, no vision model, no CV anywhere. It is a text-only local-first RAG agent — Ollama generation, text embeddings, pgvector retrieval. There is no frame stream, no detection model, no pixel data in any path. This template does not map to buffr in any form, not even as a stretch.

- **How to make it apply:** It doesn't apply cleanly, and the honest move is to say so. You would reach for this template only if an interviewer explicitly asked you to design a CV system — at which point you walk the canonical architecture above (preprocess → on-device detector → NMS + tracking → consumer) on its own merits, without forcing a buffr mapping. There is no real buffr file to cite here because there is no surface to grow it from; buffr would have to become a different kind of product (one that ingests images) before any of this architecture became relevant. Kept brief on purpose — pretending otherwise would be the marketing voice this guide avoids.
