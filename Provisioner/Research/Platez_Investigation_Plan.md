# Platez Integration — Investigation Plan

**Purpose:** Define the discovery work required before a PRD can be written for integrating Platez into the RPLATE provisioning flow.

**Output of this investigation:** A validated PRD covering (1) what Platez needs to do to process registration documents, and (2) how Platez slots into the current provisioning workflow.

---

## How to Use This Document

Each section below is a workstream. For every question, the investigation should produce a written finding — a short, factual answer with any supporting evidence (screenshots, sample data, measurements, API docs). Those findings become the source material for the PRD author.

Where a question can't be answered without a prototype or test run, note that as a spike and timebox it.

---

## Workstream 1 — Understand the Current Provisioning Flow in Full Detail

The goal is to document exactly what happens today, end to end, so the PRD can specify precisely where and how Platez plugs in.

### 1.1 The Provisioning Queue

- What triggers a new entry in the Provisioning Queue — a mobile app event, a webhook, a scheduled job, or something else?
- What does the complete data model look like? Document every field the Queue expects, its data type, format constraints, and any validation rules.
- How do staff currently interact with the Queue — through a web admin UI, a direct database tool, or an API? Is there documentation for the interface?
- Can fields be partially populated and saved, or does the Queue require a complete submission?
- What happens when a provisioning request fails or is rejected? Is there a formal kick-back state, or is it handled ad hoc?

### 1.2 Image Submission & Storage

- When a customer submits their plate photo and registration photo via the mobile app, where do those images go? (S3 bucket, CDN, database blob, etc.)
- Are images accessible via a URL at the time staff review them, or do they require a special retrieval step?
- Is there a consistent naming convention or ID linking an image to its provisioning request?
- Are there any existing image quality constraints imposed by the app (minimum resolution, file size limits, accepted formats)?

### 1.3 The VIN Lookup API

- Which third-party API is currently used to look up VIN from LPN?
- What is the hit rate — how often does it return a valid VIN versus failing or returning nothing?
- When it fails, what is the current manual fallback?
- Is the VIN from this API considered authoritative, or does it still need to be cross-checked against the registration document?

### 1.4 Staff Workflow & Pain Points — Direct Observation

- Shadow at least two provisioning staff members through complete end-to-end requests, including both straightforward and problematic cases.
- Time each step. Where does time actually go?
- What are the most common reasons a request requires extra manual work?
- What does a fraudulent or suspicious submission look like in practice? How do staff currently identify it?
- What fields do staff most frequently correct after the VIN API returns data?

---

## Workstream 2 — Audit Platez's Current Capabilities

The goal is to establish an honest baseline before any new development is scoped. Don't assume — measure.

### 2.1 LPN Extraction Accuracy

- Run Platez against a representative sample of real provisioning submissions (minimum 100 images). Include a mix of standard plates, vanity plates, legacy designs, and plates with special characters (hearts, stars, etc.).
- Measure character-level accuracy, not just full-plate accuracy. A plate reading "7ABC 123" when the answer is "7ABC123" is a failure for provisioning purposes.
- Identify which plate types or conditions produce the most errors. Hypotheses to test: high glare, night shots, angled photos, damaged plates, non-CA designs.
- Does Platez currently return a confidence score? If not, is the underlying model capable of it?

### 2.2 Plate Design Type Identification

- Which Plate Design Types can Platez currently identify? Produce a definitive list.
- Which types does it miss or misclassify? What are the consequences of a misclassification in the provisioning context?
- What is the design type taxonomy used in the Provisioning Queue? Map Platez's current output to that taxonomy and identify any gaps.

### 2.3 Infrastructure & API Readiness

- How is Platez currently hosted? Is it a callable API today, or is it a standalone app with no programmatic interface?
- What does a Platez API call look like — what does it accept as input, and what does it return?
- What are the current latency characteristics? What is the P95 response time under normal conditions?
- What would break if Platez received concurrent requests? Is there any rate limiting, queuing, or scaling mechanism?
- What does it cost to run Platez per request, and how does that scale with provisioning volume?

### 2.4 Failure Modes

- What does Platez return when it cannot process an image — a null, an exception, an error code, or something else?
- Is the failure mode distinguishable from a low-confidence result?
- Has anyone documented known edge cases? If not, produce a short taxonomy from the sample run.

---

## Workstream 3 — Define the Registration Document Processing Requirements

The goal is to understand what a registration document module needs to do before writing a single line of spec. This is the highest-uncertainty area and requires both research and prototyping.

### 3.1 Document Taxonomy

- Collect at least 30 real registration document images from recent provisioning submissions spanning different document types (Validated Registration Card, DMV printout, digitally produced copy, etc.).
- For each type, document: the layout, which fields are present, where they are positioned on the page, and what font/print style is used.
- Are there meaningful differences between document versions issued in different years? If so, document those variants.
- What does an expired registration look like visually? Does the document itself change, or is it purely a date field that indicates expiry?

### 3.2 Field Extraction Feasibility — Prototype Spike

Run a vision-language model (or OCR pipeline) against the collected document sample and attempt to extract each field required by the Provisioning Queue. For each field, answer:

- Can it be reliably extracted from a flat, well-photographed document?
- What degrades extraction quality — rotation, shadows, partial occlusion, crumpled paper, glare on laminate?
- What confidence threshold separates a reliable extraction from an unreliable one?
- Are any fields structurally ambiguous (e.g. a field that looks different across document versions)?

Produce a per-field accuracy table from this spike. This is the single most important output from Workstream 3.

### 3.3 Expiry Validation Logic

- Exactly what constitutes a valid vs. expired registration document for Reviver's provisioning purposes? Get a definitive answer from Operations and/or Legal.
- Is expiry determined by the registration card date, the sticker date, both, or something else?
- Is there a grace period? If so, what is it?
- What should happen when the expiry field cannot be read — auto-reject, kick to human, or request resubmission?

### 3.4 Fraud Signal Definition

- Interview operations staff: what does a fraudulent or altered registration document actually look like? Collect any historical examples if they exist.
- Research common registration document fraud patterns (edited PDFs, photocopied stickers, mismatched fonts, absent watermarks).
- For each fraud signal, assess whether it is detectable programmatically with a vision-language model vs. requiring a different technique.
- Which signals are high-confidence catches, and which are probabilistic flags that still require human judgment?
- Define what "flagged for fraud review" means operationally — who gets the flag, in what channel, with what information?

### 3.5 Cross-Document Consistency Checks

- Beyond the LPN match between plate image and registration document, what other cross-checks are meaningful? (e.g. make/year plausibility against VIN, address format sanity, name format sanity)
- What is the severity of a mismatch in each case — hard block, soft flag, or informational?

---

## Workstream 4 — Design the Integration Architecture

The goal is to answer enough architecture questions that an engineer can design the integration without ambiguity.

### 4.1 Where Does Platez Sit in the Flow?

- Map at least two integration options:
  - **Option A:** Platez processes images immediately on customer submission, before the request enters the Queue.
  - **Option B:** Images enter the Queue first (as they do today), and Platez processes them asynchronously, updating the Queue record.
- For each option, identify: the trigger mechanism, the data handoff format, the failure fallback, and the impact on staff workflow.
- Which option Operations prefers, and why.

### 4.2 Output Data Contract

- Define the exact payload Platez must return to the provisioning system. For each field in the Provisioning Queue, specify: the corresponding Platez output field name, the data type, the format, and what a null or error value looks like.
- How should Platez signal confidence — per field, per module, or overall?
- What error codes are needed? Define a complete error taxonomy.

### 4.3 Routing Logic

- Who decides the confidence thresholds that determine whether a request is auto-populated vs. kicked to human review? This is a product and operations decision, not an engineering one — get it answered before the PRD is written.
- What information does a staff member need to see when a request is routed to them for manual review? (Annotated images? Flagged fields highlighted? Side-by-side comparison of what Platez extracted vs. what the raw document shows?)
- What does the kick-back UX look like for staff? Is this a change to the existing Provisioning Queue UI, or a separate tool?

### 4.4 Audit, Override & Feedback Loop

- Every Platez decision must be logged. What is the minimum log record needed for QA spot-checking and for feeding corrections back as training data?
- When a staff member overrides a Platez-populated field, how is that correction captured and stored?
- Who owns the process of reviewing override data and deciding when model retraining is warranted?

### 4.5 Failure & Degraded-Mode Behaviour

- If Platez is unavailable, the provisioning flow must not stop. Confirm how the system falls back to the current fully-manual process without data loss.
- If Platez returns a result but with low confidence on every field, what happens? Is that treated the same as an outage?

---

## Workstream 5 — Constraints, Compliance & Stakeholder Sign-Off

These questions are not optional. Unanswered, they will block development or cause rework.

### 5.1 Data Privacy & Legal

- Registration documents contain personal data (name, address, VIN). What are the obligations regarding how long images can be retained, who can access them, and where they can be stored or processed?
- Does passing registration images to Platez (or the model it calls) constitute a data transfer requiring any consent or contractual coverage?
- Get written sign-off from Legal before the PRD is finalised.

### 5.2 Fraud & Compliance

- Is there a regulatory or compliance requirement around how fraud is detected and escalated in the provisioning process? If so, any automated fraud flagging system must be designed to satisfy it.
- Who is accountable for a fraudulent provisioning that slips through the automated system?

### 5.3 Stakeholder Alignment

- Confirm that Operations leadership endorses the Phase 1 model (automation augments staff, does not replace the review step).
- Confirm that Engineering has reviewed the Platez hosting and integration approach and considers it feasible within the proposed timeline.
- Confirm that the confidence thresholds and routing logic have been reviewed and agreed by Operations before they are written into the PRD as requirements.

---

## Investigation Output — What the PRD Author Needs

When the investigation is complete, the following must exist as written, reviewable artefacts:

| Artefact | Produced By | Used For |
|---|---|---|
| Provisioning Queue data model (all fields, types, validation rules) | Engineering | Data contract section of PRD |
| Platez LPN accuracy benchmark results (per plate type) | Engineering / Product | Acceptance criteria |
| Registration document type taxonomy with sample images | Operations | Module B scope definition |
| Per-field extraction accuracy table from prototype spike | Engineering | Module B acceptance criteria |
| Confirmed expiry validation rules | Operations / Legal | Module B logic spec |
| Fraud signal taxonomy with detectability assessment | Operations / Engineering | Module B fraud requirement |
| Integration option comparison (Option A vs B) with ops preference | Product / Operations | Architecture section of PRD |
| Platez output data contract (draft) | Engineering | Integration spec |
| Confidence threshold recommendations | Operations | Routing logic spec |
| Legal sign-off on data handling | Legal | Compliance section of PRD |
| Staff kick-back UX requirements | Operations | UI/UX scope |

Only once all of the above exist should PRD drafting begin.

---

*Document status: Draft — circulate to Engineering, Operations, and Legal for workstream assignment before investigation begins.*
