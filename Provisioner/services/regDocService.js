const VLM_URL = "http://127.0.0.1:1234/v1/chat/completions";

// Auto-detect image MIME type from base64 header bytes
function detectDataUri(base64) {
  if (base64.startsWith('/9j/')) return `data:image/jpeg;base64,${base64}`;
  if (base64.startsWith('iVBOR')) return `data:image/png;base64,${base64}`;
  if (base64.startsWith('UklGR')) return `data:image/webp;base64,${base64}`;
  return `data:image/jpeg;base64,${base64}`; // fallback
}
const MODEL_NAME = "qwen/qwen2.5-vl-7b";

const REG_DOC_PROMPT = `Extract vehicle registration data from the image. Act as a strict data-entry clerk. Output ONLY valid JSON without any markdown formatting wrappers.
If a field is obscured, unreadable, or not present, return null. Do not guess. Pay special attention to splitting the City, State, and Zipcode correctly from the address block.

The VIN is a strict 17-character alphanumeric string. Do not confuse it with the License Plate Number, which is typically 6-8 characters.

Return this exact JSON structure:
{
  "State": "string (2-letter abbreviation of the document's issuing state)",
  "VIN": "string (17 characters)",
  "Plate Number": "string",
  "Temporary License Plate": "boolean",
  "Expiration Date": "string (YYYY-MM-DD)",
  "Make": "string",
  "Year": "string (4 digits)",
  "Owner First Name": "string (First name only)",
  "Owner Last Name": "string (Last name only)",
  "Registration Address1": "string (Street number and name)",
  "Registration Address2": "string (Apt, Unit, Suite, or null)",
  "Registration City": "string",
  "Registration State": "string (2-letter)",
  "Registration Zipcode": "string"
}`;

async function processRegistrationDocument(base64Image) {
  const payload = {
    model: MODEL_NAME,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: REG_DOC_PROMPT },
          { type: "image_url", image_url: { url: detectDataUri(base64Image) } }
        ]
      }
    ],
    temperature: 0.0,
    max_tokens: 800
  };

  try {
    const response = await fetch(VLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`VLM API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsedData = JSON.parse(content);
    
    // Normalize and validate
    let warnings = [];
    if (parsedData.VIN && parsedData.VIN.length !== 17) {
      warnings.push("VIN_LENGTH_MISMATCH");
    }
    if (!parsedData["Expiration Date"]) {
      warnings.push("EXPIRY_DATE_UNREADABLE");
    }

    return {
      status: warnings.length > 0 ? "partial" : "success",
      data: parsedData,
      warnings: warnings
    };

  } catch (err) {
    console.error("RegDoc VLM Processing Error:", err);
    return {
      status: "error",
      data: null,
      warnings: ["SYSTEM_FAILURE", err.message]
    };
  }
}

module.exports = { processRegistrationDocument };