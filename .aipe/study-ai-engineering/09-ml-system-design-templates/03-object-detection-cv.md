# Object Detection / Computer Vision

### *interview reframe · fixed 9-bullet shape · Phase 5 anchor C5.13*

---

**The prompt:** Design a real-time, on-device computer-vision system that detects objects in a video stream.

---

**Standard architecture**

```text
┌──────────────────────────── ON-DEVICE OBJECT DETECTOR (top-to-bottom) ──────────────┐
│                                                                                      │
│   camera / video stream  (frames at a fixed rate, e.g. 30fps)                        │
│            │                                                                          │
│            ▼                                                                          │
│   ┌──────────────────┐     resize, normalize, color-convert to model input tensor    │
│   │ PREPROCESS       │ ◄── runs per frame; must finish inside the frame budget       │
│   └────────┬─────────┘                                                                │
│            │ input tensor                                                             │
│            ▼                                                                          │
│   ┌──────────────────┐     a pre-trained detector: bounding boxes + class + score    │
│   │ DETECT (model)   │ ◄── single-stage (YOLO/SSD) for real-time, on quantized       │
│   │                  │     weights running on NPU/GPU/accelerator                    │
│   └────────┬─────────┘                                                                │
│            │ raw detections (overlapping boxes)                                       │
│            ▼                                                                          │
│   ┌──────────────────┐     non-max suppression, confidence filter, class map         │
│   │ POST-PROCESS     │ ◄── NMS collapses duplicate boxes per object                  │
│   └────────┬─────────┘                                                                │
│            │ final detections                                                         │
│            ▼                                                                          │
│   ┌──────────────────┐     optional: track IDs across frames (Kalman / IOU match)    │
│   │ TRACK (optional) │                                                                │
│   └────────┬─────────┘                                                                │
│            │                                                                          │
│            ▼                                                                          │
│   ┌──────────────────┐                                                                │
│   │ CONSUMER         │ ──► overlay / trigger / count / downstream logic               │
│   └──────────────────┘                                                                │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

**Data model**

- **Frame** — a single timestamped image tensor from the stream; the unit of work.
- **Detection** — (bounding box, class label, confidence) per detected object; the model's raw output.
- **Track** — a stable ID linking the same object's detections across frames; what turns per-frame boxes into objects-over-time.
- **Model artifact** — the pre-trained, typically quantized detector weights + label map; versioned and shipped to the device.
- **Class taxonomy** — the fixed label set the detector was trained on; defines what it can and cannot see.

---

**Key components**

- **Preprocessor** — conforms each frame to the model's expected input; choose **fixed-size letterbox resize** over naive stretch so aspect ratio (and box geometry) is preserved.
- **Detector** — the pre-trained network producing boxes; choose a **single-stage detector (YOLO/SSD)** over two-stage (Faster R-CNN) for real-time work because single-stage trades a little accuracy for the latency the frame budget demands.
- **Post-processor** — collapses overlapping boxes and filters low confidence; choose **non-max suppression** because a single object fires many overlapping anchors and NMS is the standard dedupe.
- **On-device runtime** — executes the model within the power/thermal envelope; choose **quantized weights (INT8) on the device's NPU/accelerator** over float32 on CPU because real-time on-device requires it (see `../08-machine-learning/13-quantization.md`, `../08-machine-learning/12-on-device-inference.md`).

---

**Scale concerns** (ordered by which hits first)

- **At 30fps, the entire pipeline has ~33ms per frame.** Preprocess + inference + post-process must finish inside that budget or frames drop; this is the first wall and it dictates single-stage + quantization before anything else.
- **At sustained full-rate inference, thermal throttling kicks in.** On-device accelerators throttle under continuous load; after minutes the effective FPS drops, so you design for the *throttled* clock, not the burst clock.
- **At higher input resolution, memory bandwidth — not FLOPs — bounds you.** Doubling resolution quadruples the input tensor; on-device the bottleneck becomes moving that tensor through memory, capping resolution well before compute does.
- **At deployment across device classes, the slowest accelerator sets the contract.** A model that hits 30fps on the flagship NPU may manage 8fps on the budget device; the fleet's floor, not its ceiling, defines "real-time."

---

**Eval framing**

- **Offline:** mean Average Precision (mAP) at IoU thresholds (e.g. mAP@0.5, mAP@0.5:0.95) on a held-out labeled image set — the standard detection metric pairing localization (IoU) with classification (precision/recall across classes).
- **Online:** measured latency (p50/p99 per frame), realized FPS under thermal load, and dropped-frame rate on-device — because a model that's accurate offline but misses the frame budget on the target hardware fails the actual requirement.
- **Per-deployment:** the on-device fleet's *worst* device class sets the online bar; eval must run on representative hardware, not just the dev workstation, or the latency numbers are fiction.

---

**Common failure modes**

- **Domain gap** — the detector was trained on clean daytime images and degrades in low light / motion blur / novel angles. *Mitigation:* evaluate on in-domain captured frames and fine-tune or augment for the deployment's real conditions (see `../08-machine-learning/06-domain-gap.md`).
- **Small / occluded objects missed** — single-stage detectors trade recall on small objects for speed. *Mitigation:* multi-scale feature maps (feature-pyramid) or a higher-resolution input, paid for in latency.
- **NMS over-suppression** — densely packed objects get merged into one box. *Mitigation:* tune the NMS IoU threshold per scene density, or use soft-NMS.
- **Latency cliff under thermal throttle** — passes the bench, fails after sustained load. *Mitigation:* eval on the throttled clock and budget for it; quantize harder if needed.

---

**Applies to this codebase: no**

buffr is a **text-only** local RAG agent. It has no camera, no frames, no pixels, no vision model, no bounding boxes, no detector, and no on-device CV runtime of any kind. Its entire input/output surface is natural-language text: a query string in, embedded to a 768-dim `nomic-embed-text:v1.5` vector, cosine-searched against text chunks in `agents.chunks`, and answered by `gemma2:9b`. There is no honest mapping from any buffr component to preprocessing-detect-postprocess-consume — forcing one (e.g. "embedding is like a feature extractor") would be the kind of stretched analogy an interviewer rightly punishes. The only genuine point of contact is *philosophical*, not architectural: buffr's local-first, on-device stance (Ollama models running on the laptop, no cloud inference) shares a constraint with on-device CV — both must fit inference inside a local hardware envelope — and that shared constraint is covered honestly in `../08-machine-learning/12-on-device-inference.md` and `13-quantization.md`. But that is a deployment philosophy, not a CV system.

---

**How to make it apply**

You don't. The honest move in the interview is to **say buffr is text-only and reach for this template only when explicitly asked to design a CV system** — then walk the canonical architecture above (preprocess → detect → post-process → consumer) on its own terms, without dragging buffr into it. Concretely:

- **Do not invent a vision path in buffr.** There are no real or expected vision files to point at; proposing one would be gold-plating a system whose entire purpose is text RAG.
- **If pressed on "could buffr ever do this":** the only true shared ground is the *on-device inference constraint* — buffr already runs models locally via Ollama under a fixed hardware budget, so the latency/thermal/quantization reasoning in `../08-machine-learning/12-on-device-inference.md` and `13-quantization.md` transfers as *principle*, not as code. The frame budget for CV is the latency budget for local LLM inference, viewed through a different lens.
- **Demonstrate the recognition itself.** The interview signal here is knowing *when a template doesn't apply* and saying so cleanly, then designing the textbook system well — not manufacturing a false mapping. "buffr is text-only, so this is a from-scratch design, here it is" is the strong answer.
