# Platez Integration — Phase 1 Findings

**Status:** In Progress
**Purpose:** This document captures the validated answers and decisions resulting from the `Platez_Investigation_Plan.md`. It serves as the precursor to the formal Product Requirements Document (PRD) for Phase 1. 

The resulting PRD will explicitly cover two parallel tracks:
1. **Platez Upgrades:** Updates to the existing Platez application to support Registration Documents and data normalization.
2. **Provisioning Integration:** How the Reviver backend orchestrates the workflow, performs cross-referencing, and routes edge cases to human staff.

---

## 1. Scope and Architecture (Workstreams 1 & 4)

### 1.1 Integration Architecture
*   **Decision:** **Option B (Asynchronous Background Processing)**.
*   **Workflow:** Submissions from the customer mobile app will enter the Provisioning Queue as they do today. The system will asynchronously send the uploaded images (License Plate and Registration Document) to the Platez API. Once processed, Platez will return the extracted data.
*   **Staff UX:** Staff will review the auto-populated fields in the Provisioning Queue UI alongside the original images, and can "Process", "Override", or flag as "Requires Attention".
*   **Customer UX:** No changes to the customer-facing mobile app are in scope for Phase 1. 

### 1.2 Geographic Scope
*   **Initial Rollout:** California (CA) and Arizona (AZ).
*   **Scalability Requirement:** While Phase 1 targets CA and AZ, the system must scale to all 50 states. The system will use Vision-Language Models (VLMs) for semantic extraction rather than brittle, coordinate-based OCR templates.

---

## 2. Data Contract & Field Requirements (Workstreams 1.1 & 4.2)

Based on the current Provisioning Queue Admin UI, Platez must extract and return the following fields:

| Field Name | Type | Notes / Format |
| :--- | :--- | :--- |
| State | Dropdown | Origin state of the plate (e.g., CA, AZ) |
| VIN | Text | 17-character standard vehicle identification number |
| Plate Number | Text | Extracted LPN (including handling of spaces/half-spaces) |
| Temporary License Plate | Boolean | Checkbox mapping |
| Expiration Date | Date | Format: YYYY-MM-DD |
| Make | Text | Vehicle manufacturer |
| Year | Text | Vehicle model year |
| Owner First Name | Text | Extracted from Registration Document |
| Owner Last Name | Text | Extracted from Registration Document |
| Registration Address1 | Text | Street address |
| Registration Address2 | Text | Apt, Suite, etc. |
| Registration City | Text | |
| Registration State | Dropdown | |
| Registration Zipcode | Text | |

---

## 3. Fraud, Validation, and Routing (Workstreams 3.4, 3.5, & 4.3)

### 3.1 Source of Truth Constraints
*   Third-party state APIs currently only return a binary "current" or "not current" status. They **do not** return registered owner information.
*   **Implication:** The uploaded registration document image is the **single source of truth** for verifying the Registered Owner Name and Address. 

### 3.2 The Cross-Reference Validation Engine & Confidence
*   **Confidence Scoring:** Because generative VLMs do not reliably output token-level confidence scores for JSON, routing confidence is determined deterministically via cross-referencing.
*   **Validation Logic:** The Provisioning backend will cross-reference `Customer_Input` vs. `Platez_Plate_OCR` vs. `Platez_RegDoc_OCR`.
*   **Routing:** 
    *   If all data points match perfectly (or within acceptable thresholds), the Provisioning Queue auto-populates for rapid processing.
    *   If there is a mismatch (e.g., Customer input 17-char VIN, but Platez RegDoc OCR returned a 7-char LPN by mistake), the submission is flagged as **"Requires Attention"** for manual human review.

### 3.3 Fraud Scope Decision
*   **Phase 1 Fraud Detection:** Strictly limited to data consistency checks (mismatched VINs, names, or unreadable expiration dates). 
*   **Phase 2 Scope:** Forensic image analysis (detecting photoshopped elements, mismatched fonts, absent watermarks) is deliberately scoped out of Phase 1 to ensure rapid operational deployment. 

---

## 4. Failure Modes & Feedback Loops

### 4.1 System Failure Fallback
*   If Platez cannot process an image (HTTP 500, timeout, or unparseable JSON), the system will gracefully degrade. The Provisioning Queue will flag the record as requiring full manual entry, mirroring the current zero-automation workflow. No provisioning requests will be blocked by a Platez outage.

### 4.2 Override Data Ownership
*   Any field manually overridden by a Provisioning Admin will be explicitly logged.
*   **Ownership:** The Product and Data Science teams will jointly own the feedback loop, reviewing override logs bi-weekly to identify model drift, specific state layout failures, or needed prompt tuning.

---

## 5. Workstream 3.2: Feasibility Spike Results (Registration OCR)

A batch test was conducted using `qwen2.5-vl-7b` on 9 real-world registration documents (across CA, AZ, and GA). 
*   **Feasibility:** Highly successful. The VLM successfully extracts dense text (VINs, addresses) semantically without template mapping.
*   **Address Splitting:** The model successfully separates multi-line addresses into Address1, Address2, City, State, and Zip based on prompt instructions.

**Known Quirks requiring Normalization in Platez (Part 1 of PRD):**
1.  **Name Formatting:** Documents vary between `LAST FIRST` and `FIRST LAST`. Platez will need normalization logic to standardize extraction.
2.  **Date Formatting:** Dates occasionally output as `MM/DD/YYYY` instead of `YYYY-MM-DD`. Standard code-level parsing will be required in the Platez payload construction.
3.  **LPN / VIN Transposition:** In some layouts, the model mistakes a 7-character LPN for the VIN. This is mitigated entirely by the Cross-Reference Validation Engine (Section 3.2) and ensuring 17-character validation rules in Platez.

---

## 6. Workstream 5 (Compliance & Legal)
*   **Collection Consent:** Cleared. Customers explicitly submit this PII (Name, Address, VIN) via the mobile app with full volition for the purpose of provisioning. No new consent framework is required for collection.
*   **Processing Note:** Legal/Infosec simply needs to verify the VLM hosting environment. If the VLM is self-hosted (e.g., local Qwen models on Reviver infrastructure), data never leaves the boundary and compliance is inherently satisfied. If a third-party cloud API (e.g., Anthropic/OpenAI) is used for production, standard zero-retention B2B agreements must be confirmed.