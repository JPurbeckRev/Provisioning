const fs = require('fs');
const path = require('path');

async function testVLM(imagePath) {
  const prompt = `Extract vehicle registration data from the image. Act as a strict data-entry clerk. Output ONLY valid JSON without any markdown formatting wrappers.
If a field is obscured, unreadable, or not present, return null. Do not guess. Pay special attention to splitting the City, State, and Zipcode correctly from the address block.

Return this exact JSON structure:
{
  "State": "string (2-letter abbreviation of the document's issuing state)",
  "VIN": "string (17 characters)",
  "Plate Number": "string",
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

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64Image}`;

  const payload = {
    model: "qwen2.5-vl-7b",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUri } }
        ]
      }
    ],
    temperature: 0.0,
    max_tokens: 500
  };

  try {
    const response = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim());
  } catch (err) {
    return { error: err.message };
  }
}

async function runBatch() {
  const dir = 'reg';
  const files = fs.readdirSync(dir).filter(f => f.match(/\.(png|jpg|jpeg|webp)$/i));
  const results = {};
  
  for (const file of files) {
    console.log(`Processing: ${file}...`);
    results[file] = await testVLM(path.join(dir, file));
  }
  
  fs.writeFileSync('reg_batch_results.json', JSON.stringify(results, null, 2));
  console.log('Batch processing complete. Saved to reg_batch_results.json');
}

runBatch();