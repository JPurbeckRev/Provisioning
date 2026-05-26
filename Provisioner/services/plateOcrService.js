const VLM_URL = "http://127.0.0.1:1234/v1/chat/completions";

function detectDataUri(base64) {
  if (base64.startsWith('/9j/')) return `data:image/jpeg;base64,${base64}`;
  if (base64.startsWith('iVBOR')) return `data:image/png;base64,${base64}`;
  if (base64.startsWith('UklGR')) return `data:image/webp;base64,${base64}`;
  return `data:image/jpeg;base64,${base64}`;
}
const MODEL_NAME = "qwen/qwen2.5-vl-7b";

const PLATE_OCR_PROMPT = `Extract information from this license plate image.
Return exactly this JSON structure:
{
  "plate_string": "string (alphanumeric only, no separators)",
  "formatted_lpn": "string (IMPORTANT: Do NOT insert spaces unless there is a clear, physical, wide gap between the characters on the actual plate. If the characters are printed continuously or grouped tightly, do NOT add spaces between them. Only replicate the exact physical spacing as seen on the metal)",
  "state": "string (2-letter)",
  "design_type": "string (Plate Design Type)",
  "vertical_text": "string or null (e.g. DP, DV on edges)",
  "vertical_text_position": "left, right, or null",
  "is_disabled": "boolean (true if wheelchair/ISA logo present or DP/DV present)",
  "disabled_type": "string or null (e.g. DV, DP, DPE, DVE)"
}`;

async function processPlateImage(base64Image) {
  const payload = {
    model: MODEL_NAME,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PLATE_OCR_PROMPT },
          { type: "image_url", image_url: { url: detectDataUri(base64Image) } }
        ]
      }
    ],
    temperature: 0.0,
    max_tokens: 500
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
    return parsedData;
  } catch (err) {
    console.error("Plate OCR Processing Error:", err);
    return { plate_string: null, formatted_lpn: null, state: null, design_type: null, vertical_text: null, vertical_text_position: null, is_disabled: false, disabled_type: null };
  }
}

module.exports = { processPlateImage };