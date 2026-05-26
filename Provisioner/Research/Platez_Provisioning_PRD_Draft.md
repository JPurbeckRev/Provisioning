# Product Requirements Document (PRD)
**Project:** Platez Integration — Phase 1 (Operational Enhancement)
**Document Status:** Draft

## 1. Executive Summary
The Provisioning process for RPLATE digital license plates is currently highly manual. Customers upload images of their license plate and registration document, and staff manually transcribe this data into the Provisioning Queue. 

**Phase 1 Objective:** Integrate the "Platez" AI system into the Reviver backend to asynchronously process these images, auto-populate data fields, and cross-reference extracted data against customer inputs. This phase focuses solely on staff operational efficiency and data validation; customer-facing mobile apps will not be altered.

This PRD is divided into two distinct tracks:
1. **Platez Upgrades:** Updates required to the standalone Platez application.
2. **Provisioning Integration:** Updates required to the Reviver Provisioning backend and staff UI.

---

## Part 1: Platez Application Upgrades

The existing Platez application currently extracts data from physical metal license plates. It must be upgraded to process vehicle registration documents and return standardized data payloads.

### 1.1 Registration Document VLM Module
*   **Engine:** Implement a Vision-Language Model (VLM) pipeline to semantically extract data from registration documents. Template-based coordinate OCR is prohibited due to variance across 50 states. Engineering owns the specific model selection based on accuracy, cost, and latency targets.
*   **Compliance Constraint:** If a third-party cloud inference API is selected over self-hosted infrastructure, a zero-retention data processing agreement must be confirmed with Legal/Infosec prior to production deployment to protect PII.
*   **Data Extraction & Normalization Requirements:** 
    *   **VIN:** Must enforce a strict 17-character alphanumeric extraction. Must not return 6-8 character LPNs in this field.
    *   **Dates:** All extracted dates (Expiration Date) must be programmatically normalized to `YYYY-MM-DD` format before returning the payload.
    *   **Names:** Extract Owner First Name and Owner Last Name, handling standard permutations (FIRST LAST vs LAST FIRST).
    *   **Addresses:** Address blocks must be parsed and split into Address1, Address2 (Apt/Suite, if applicable), City, State, and Zipcode.

### 1.2 Output Data Contract & Error Envelope
Platez must expose an API endpoint that accepts image payloads (Plate + RegDoc). The schema must account for unreadable fields and extraction failures. Unreadable or missing fields must return `null` (not empty strings).

```json
{
  "status": "success | partial | error",
  "data": {
    "State": "string (2-letter) | null",
    "VIN": "string (17-char) | null",
    "Plate Number": "string | null",
    "Temporary License Plate": "boolean | null",
    "Expiration Date": "string (YYYY-MM-DD) | null",
    "Make": "string | null",
    "Year": "string (4-digits) | null",
    "Owner First Name": "string | null",
    "Owner Last Name": "string | null",
    "Registration Address1": "string | null",
    "Registration Address2": "string | null",
    "Registration City": "string | null",
    "Registration State": "string (2-letter) | null",
    "Registration Zipcode": "string | null",
    "Plate Design Type": "string | null"
  },
  "warnings": [
    "Array of strings for flagged issues. Expected vocabulary:",
    "  - VIN_LENGTH_MISMATCH",
    "  - LPN_VIN_TRANSPOSITION_SUSPECTED",
    "  - EXPIRY_DATE_UNREADABLE",
    "  - ADDRESS_PARSE_FAILURE"
  ]
}
```

---

## Part 2: Provisioning System Integration

The Reviver backend must be updated to route images to Platez and intelligently handle the response to assist Provisioning staff.

### 2.1 Architecture & Workflow (Option B)
*   **Asynchronous Flow:** Customer submissions enter the Provisioning Queue database normally. A background job sends the associated image URLs/blobs to the Platez API.
*   **State Scope:** Initial validation targeting California (CA) and Arizona (AZ) registrations, but the data pipeline must support arbitrary states.
*   **Rollout Gating:** *Note: The initial VLM feasibility was validated on a 9-document spike. Before production rollout, Engineering must execute a broader regression test against a larger historical dataset (e.g., 100+ documents) to validate the prompt against edge cases and confirm accuracy metrics.*

### 2.2 The Cross-Reference Validation Engine
The Provisioning system must not blindly trust Platez output. It will act as a verification layer against the customer's self-reported data.
*   **Inputs for Comparison:**
    1. Customer Mobile Input (LPN, sometimes VIN)
    2. Platez Plate OCR Output
    3. Platez Registration Document OCR Output
*   **Logic:** The system compares the LPN and VIN across all three sources.

### 2.3 Routing Logic and Staff UI
*   **Auto-Populate (Strict Match):** Because generative VLMs do not always output reliable token-level confidence scores, routing is determined deterministically. `Customer_Input_VIN` and `Customer_Input_LPN` must **exactly match** the Platez extraction (ignoring case/spaces). If they match strictly, the Provisioning Queue UI fields are pre-populated. Staff only need to verify and click "Process".
*   **Mismatch / Fraud Flag (Requires Attention):** If a cross-reference check fails, or if Platez returns `null` for a critical field (e.g., unreadable VIN), the Queue record is flagged with a **"Requires Attention"** status.
*   **System Failure / Error Routing:** If the Platez API times out, returns an HTTP 500, or outputs unparseable JSON, the Provisioning flow must not block. The record will enter the Queue with a **"System Error - Manual Entry Required"** flag, falling back to the legacy manual transcription process.
*   **UI Updates:** 
    *   Staff must be able to view the uploaded images side-by-side with the extracted data.
    *   Staff must have an "Override" capability to manually correct Platez mistakes before processing.
    *   Overridden fields must be logged to a dedicated database table. Product and Data Science teams will jointly own reviewing this override data bi-weekly to identify model drift and retrain/prompt-tune as needed.

---

## 3. Out of Scope for Phase 1
*   **Customer Mobile App Changes:** No UI changes or new photo constraints for customers.
*   **Zero-Touch Automation:** Phase 1 will not automatically approve and finalize a provisioning request. A human staff member must click "Process" on every record.
*   **Advanced Forensic Fraud Detection:** AI will not perform pixel-level analysis for photoshopped documents; fraud detection is limited to data consistency checks.