const fs = require('fs');

async function testVLM(imagePath) {
  const prompt = `Extract the vehicle registration data from the provided image. Act as a strict data-entry clerk. Output ONLY valid JSON without any markdown formatting wrappers (no \`\`\`json).
If a field is obscured, unreadable, or not present, return null for that field. Do not guess.

Return this exact JSON structure:
{
  "State": "string (2-letter abbreviation)",
  "VIN": "string (17 characters)",
  "Plate Number": "string",
  "Expiration Date": "string (YYYY-MM-DD)",
  "Make": "string",
  "Year": "string (4 digits)",
  "Owner First Name": "string",
  "Owner Last Name": "string",
  "Registration Address1": "string",
  "Registration Address2": "string",
  "Registration City": "string",
  "Registration State": "string",
  "Registration Zipcode": "string"
}`;

  console.log(`Testing image: ${imagePath}`);
  
  // Read and convert image to base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64Image}`;

  const payload = {
    model: "qwen2.5-vl-7b", // or just default for LM Studio
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

    if (!response.ok) {
      console.error(`Error: ${response.status} ${response.statusText}`);
      const errText = await response.text();
      console.error(errText);
      return;
    }

    const data = await response.json();
    console.log("Response from local model:");
    console.log(data.choices[0].message.content);
  } catch (err) {
    console.error("Fetch failed. Is LM Studio running on port 1234?", err.message);
  }
}

const targetImage = process.argv[2] || "reg/download.png";
testVLM(targetImage);