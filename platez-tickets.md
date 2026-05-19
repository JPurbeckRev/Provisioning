# Platez — Implementation Tickets

## Priority Legend
- 🔴 P0 — Critical
- 🟠 P1 — High
- 🔵 P2 — Medium

---

## Data & Logging

### PLZ-01 🔴 P0 — Structured failure logging with field-level error taxonomy

**Summary:** Before fine-tuning, you need to know where the pipeline fails. Log every discordance with a typed reason.

**Detail:** Extend `_verification.discordance` to include a `failure_type` enum:
- `char_confusion` (0/O, 1/I, 5/S, 8/B, 2/Z)
- `vertical_text_missed`
- `sticker_hallucinated`
- `sticker_missed`
- `design_misclassified`
- `bleed_not_stripped`

Build a simple dashboard or weekly export that buckets failures by type. This tells you whether to invest in prompt work, post-processing, or fine-tuning — and on which pass.

**Tags:** `data` `pipeline`

---

### PLZ-02 🔴 P0 — Ground-truth labeling UI for run review

**Summary:** Every run you log is potential training data — but only if you can mark it correct or corrected.

**Detail:** Add a review mode to the admin panel. For each run: show image + current analysis, allow field-by-field correction, flag as `ground_truth: true` when all fields are confirmed. Store corrected runs separately. Target: 200 labeled plates before considering fine-tuning. Tie this into the existing feedback mechanism.

**Tags:** `data` `infra`

---

## Pipeline Reliability

### PLZ-03 🔴 P0 — Pass 5 null-out carve-out for high-confidence corrections

**Summary:** Current "no null-outs" rule can preserve hallucinated values that Pass 5 correctly wants to erase.

**Detail:** Allow Pass 5 to null out a field if:
- Pass 5 confidence for that field ≥ 0.85, AND
- The original value's confidence was ≤ 0.6

Applies primarily to `vertical_text` and `expiration_month`/`expiration_year`. Log all null-outs with before/after so you can audit the rule's behavior over time.

**Tags:** `pipeline` `post-process`

---

### PLZ-04 🟠 P1 — Context window audit — ensure 4096 minimum for multi-pass calls

**Summary:** Pass 5 sends image + full JSON + 8-point checklist. At 1024 context the KV cache may truncate input.

**Detail:** Audit token usage per pass by logging prompt token counts from the LM Studio response headers. Set LM Studio context to 4096 minimum. Add a runtime warning if estimated prompt tokens exceed 80% of configured context. Gemini is not affected — this is LM Studio-only.

**Tags:** `infra` `pipeline`

---

### PLZ-05 🟠 P1 — Plate-first image crop before 1024px resize

**Summary:** Full-scene photos reduce sticker pixel density to ~10px — below reliable OCR threshold.

**Detail:** Before the 1024px resize step, attempt to detect and crop to the plate bounding box. Options:
- (a) Use a lightweight YOLO plate-detector running locally
- (b) Ask the VLM to return a bounding box estimate in Pass 1 and re-crop for Pass 2a/4
- (c) Let users draw a crop rectangle in the UI

Even a manual crop option unblocks the data-labeling pipeline immediately.

**Tags:** `pipeline` `infra`

---

### PLZ-06 🟠 P1 — Pass 4 edge crop width reduction experiment (55% → 40%)

**Summary:** Current 55% creates center overlap between left/right crops — redundant pixels, potential confusion.

**Detail:** A/B test `cropEdge()` at 40% vs current 55%. Log which width produces higher `confidence.vertical_text` scores and lower discordance on DP/DV plates. Gate the change on 50+ DP/DV plate runs. If 40% performs equally, ship it — less input noise is better.

**Tags:** `pipeline`

---

## Commercial Readiness

### PLZ-07 🟠 P1 — Accuracy benchmarking harness with per-field metrics

**Summary:** You can't sell accuracy claims without measured baselines. Build the test harness now.

**Detail:** Using labeled data from PLZ-02, build a batch eval script: feed N plates, compare output to ground truth, report per-field accuracy:
- `plate_number` exact match
- `state`
- `design_type`
- `expiration_month`
- `expiration_year`
- `vertical_text`
- `is_disabled`

Report separately for: sequential vs vanity, standard vs disabled, CA vs out-of-state. Run against both qwen2.5-vl-7b and Gemini 2.5 Flash to establish a model comparison baseline.

**Tags:** `data` `infra`

---

### PLZ-08 🔵 P2 — API rate limiting and per-client auth on server.js proxy

**Summary:** Current proxy has no rate limiting — required before exposing to external clients.

**Detail:** Add per-API-key rate limiting (requests/minute + daily cap) to the server.js proxy layer. Add bearer token validation for non-LM-Studio clients. Log client ID alongside `_provider` and `_model` in run JSON. This unblocks selling API access as a product tier.

**Tags:** `infra`

---

### PLZ-09 🔵 P2 — Fine-tuning readiness: export labeled data in VLM training format

**Summary:** When you hit 500+ ground-truth labels, you'll want them in the right format immediately.

**Detail:** Build an export script that takes ground-truth-flagged runs and outputs LLaMA-Factory or Swift compatible JSONL:

```json
{
  "image": "...(base64)",
  "conversations": [
    { "from": "human", "value": "<image>\nAnalyze this plate..." },
    { "from": "gpt", "value": "{...ground truth JSON...}" }
  ]
}
```

Validate schema against current Pass 1 output format. This is a dependency for any fine-tuning sprint.

**Tags:** `data` `infra`
