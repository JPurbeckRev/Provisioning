function cropCorner(b64jpeg, side, widthPct = 0.30, heightPct = 0.30, scale = 4) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const cropW = Math.max(30, Math.round(img.width  * widthPct));
          const cropH = Math.max(30, Math.round(img.height * heightPct));
          const srcX  = side === 'right' ? img.width - cropW : 0;
          const canvas = document.createElement('canvas');
          canvas.width  = cropW * scale;
          canvas.height = cropH * scale;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          // Boost contrast + saturation so sticker text stands out against plate background
          ctx.filter = 'contrast(2.2) brightness(1.1) saturate(1.5)';
          ctx.drawImage(img, srcX, 0, cropW, cropH, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.95).split(',')[1]);
        };
        img.onerror = reject;
        img.src = 'data:image/jpeg;base64,' + b64jpeg;
      });
    }

    // cropEdge: extracts a vertical strip from left or right edge and scales up.
    // Characters are upright but stacked vertically — NO rotation needed.
    // Used for reading DP/DV suffixes that the model misses in the full image.
    // widthPct=0.55 with overlap: left crop = 0..55%, right crop = 45..100%
    // This ensures the DP/DV text (which sits between the icon and plate number) is captured.
    function cropEdge(b64jpeg, side, widthPct = 0.55, scale = 3) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const cropW = Math.max(20, Math.round(img.width * widthPct));
          const cropH = img.height;
          const srcX = side === 'right' ? img.width - cropW : 0;

          const out = document.createElement('canvas');
          out.width = Math.round(cropW * scale);
          out.height = Math.round(cropH * scale);
          const ctx = out.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.filter = 'contrast(2.0) brightness(1.1) saturate(1.3)';
          ctx.drawImage(img, srcX, 0, cropW, cropH, 0, 0, out.width, out.height);

          resolve(out.toDataURL('image/jpeg', 0.95).split(',')[1]);
        };
        img.onerror = reject;
        img.src = 'data:image/jpeg;base64,' + b64jpeg;
      });
    }

    async function callModel(promptText, modelId, apiBase, options = {}) {
      const provider = providerSelect.value;

      // Gemini models produce more verbose JSON (extra whitespace) — need higher token limit
      const maxTokens = provider === 'gemini' ? 2048 : 1024;
      const body = {
        model: modelId,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              // Support single image or array of images (e.g. two corner crops)
              ...(Array.isArray(options.imageOverride)
                ? options.imageOverride.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
                : [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${options.imageOverride || imageBase64}` } }]
              ),
              { type: 'text', text: promptText }
            ]
          }
        ]
      };

      let fetchUrl, headers;

      if (provider === 'gemini') {
        // Gemini: call Google's OpenAI-compatible endpoint directly (supports CORS)
        const apiKey = geminiKeyInput.value.trim();
        if (!apiKey) throw new Error('Gemini API key is required. Set it in Settings.');
        fetchUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
      } else {
        // LM Studio: route through server proxy
        const isRemote = !window.location.hostname.match(/localhost|127\.|192\.168\./);
        const apiPath = isRemote ? '/Platez/api/v1/chat/completions' : '/api/v1/chat/completions';
        fetchUrl = `${apiBase}${apiPath}`;
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer lm-studio' };
      }

      const res = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }

      const data = await res.json();

      // PLZ-04: Log token usage and warn if approaching context limits
      const usage = data.usage;
      if (usage) {
        const promptTok = usage.prompt_tokens || 0;
        const completionTok = usage.completion_tokens || 0;
        const totalTok = usage.total_tokens || (promptTok + completionTok);
        console.log(`[Platez] Tokens: prompt=${promptTok} completion=${completionTok} total=${totalTok}`);
        // Warn if prompt tokens exceed 80% of a 4096 context window (LM Studio default)
        if (provider !== 'gemini' && promptTok > 3276) {
          console.warn(`[Platez] ⚠️ Context pressure: prompt tokens (${promptTok}) exceed 80% of 4096. Consider increasing LM Studio context window.`);
        }
        // Store usage on the return value for logging
        data._tokenUsage = { prompt: promptTok, completion: completionTok, total: totalTok };
      }

      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error('Model returned an empty response. It may not support vision input.');

      // Strip markdown fences unconditionally, then find the JSON object/array
      let jsonStr = raw
        .replace(/^```(?:json)?\s*/im, '')   // opening fence
        .replace(/```\s*$/m, '')              // closing fence
        .trim();
      // Extract the first complete {...} block in case there's preamble text
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];
      // Strip JS-style comments (// ...) that the model sometimes injects
      jsonStr = jsonStr.replace(/\/\/[^\n]*/g, '');
      // Strip trailing commas before } or ] (invalid JSON but common model output)
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
      try {
        return { parsed: JSON.parse(jsonStr), jsonStr, tokenUsage: data._tokenUsage || null };
      } catch {
        // Show full raw response for diagnosis (no truncation)
        throw new Error(`Could not parse model response as JSON (${raw.length} chars, finish_reason=${data.choices?.[0]?.finish_reason}):\n\n${raw}`);
      }
    }

    async function extractPlateData(imageBase64, lmStudioUrl, plateTypeTaxonomy) {
// PLZ-04: Track cumulative token usage across all passes
      const tokenTracker = { total_prompt: 0, total_completion: 0, total: 0, passes: [] };

      // Abort controller — cancel button + 90s hard timeout
      const activeAbort = new AbortController();
      const timeoutId = setTimeout(() => activeAbort?.abort(), 90000);

      // Default: use same origin (works both locally via proxy and remotely via server-side proxy)
      const apiBase = lmStudioUrl;
      const modelId = 'qwen/qwen2.5-vl-7b';

      // Taxonomy is injected AFTER pass 1 detects the state — keeps pass 1 lightweight.
      // Pass 1 omits taxonomy; pass 2 (design classification) adds only the relevant state's list.
      function buildTaxonomySection(stateKey) {
        const STATE_MAP = { 'California':'CA','Arizona':'AZ','Texas':'TX','Florida':'FL','New York':'NY' };
        const key = plateTypeTaxonomy[stateKey] ? stateKey
          : plateTypeTaxonomy[STATE_MAP[stateKey]] ? STATE_MAP[stateKey] : null;
        if (!key) return '';
        const groups = plateTypeTaxonomy[key];
        // Flat numbered list — no headers or brackets that the model could accidentally pick
        let i = 1;
        const lines = Object.values(groups).flatMap(types => types).map(t => `${i++}. ${t}`).join('\n');
        const CA_VISUAL_CUES = key === 'CA' ? `\nCalifornia plate visual cues — check BACKGROUND COLOR FIRST before any other classification:\nBLACK background + gold/yellow embossed characters + "CALIFORNIA" in gold script = Legacy Black Plate (1963). This is NEVER Standard Passenger Vehicle.\nYELLOW/GOLD background + black characters = Legacy Yellow Plate (1956). Also never Standard.\nWhite/blue gradient (standard) — THEN check special interest art: Whale Tail=ocean/wave/whale/"PROTECT OUR COAST"; Yosemite=Half Dome/valley; Lake Tahoe=mountain lake; Environmental=green nature; Arts Council=colorful abstract/"ARTS"; Breast Cancer=pink ribbon; Pet Lovers=cat/dog/paws; Firefighters=fire/helmet; Collegiate=school logo.\n` : '';
        return `\nSTEP 6 — DESIGN TYPE CLASSIFICATION${CA_VISUAL_CUES}\nSet design_type to EXACTLY one name from the numbered list below. Copy the name verbatim — do not return a number, do not paraphrase.\n\nValid types for ${key}:\n${lines}\n`;
      }

      const taxonomySection = ''; // Pass 1: no taxonomy — added in pass 2 after state is known

      const prompt1 = `You are a precise license plate reader. Analyze the image and follow every rule exactly.

STEP 1 — VERTICAL EDGE TEXT
Inspect all four edges for text printed PERPENDICULAR to the plate — meaning the text baseline runs along the SHORT axis of the plate, and you would need to rotate the plate 90° to read it normally.
This is rare: e.g. "DP" or "DV" printed sideways along the left or right edge as part of the permanent plate design.
CRITICAL DISTINCTION: State names (e.g. "California") printed in cursive or block script running horizontally across the plate are NOT vertical text — their baseline runs along the LONG axis of the plate. Only classify text as vertical if its baseline is perpendicular to the long axis.
⚠️ COMMON ERROR — DO NOT DO THIS: Reporting "California" (or any state name) as vertical_text. The cursive "California" at the top of California plates is a HORIZONTAL DESIGN ELEMENT — it reads left-to-right along the long axis. This applies to ALL state names on ALL plates. State names are NEVER vertical text. Only genuinely 90°-rotated text like "DP" or "DV" printed sideways on an edge qualifies.
If you are not certain text is genuinely rotated 90°, set vertical_text to null.

STEP 2 — DISABLED/ISA LOGO AND SUFFIX
Look for a wheelchair/ISA graphic. Set dp_logo_position to "left", "right", or "none".
⚠️ CRITICAL — DP vs DV: Disabled plates have a stacked two-letter suffix (usually on the right edge, rotated 90°). You MUST read these characters directly from the image:
- "DP" = Disabled Person (civilian)
- "DV" = Disabled Veteran
These are NOT interchangeable. The second character (P vs V) completely changes the plate classification. Read the actual pixels — do NOT infer or default to "DP". If you cannot clearly distinguish P from V, set vertical_text confidence low but still report your best read.

STEP 3 — PLATE NUMBER AND SPACING
⚠️ BEFORE reading characters: scan the gaps between every adjacent character pair. Ask yourself: "Is any gap clearly wider than the space inside the letter 'O'?" If YES → that gap is a separator.

Read the large bold alphanumeric characters in the CENTER of the plate.
Do NOT include: state name, city, slogans, decorative text, or any text found in Step 1.
On disabled plates: DP/DV on the edge and the wheelchair icon are NOT part of the plate number.

TRUNCATION CHECK: Inspect all four edges of the plate in the image. If any edge is cropped/cut off such that characters may be missing or partially visible, set potentially_truncated to true and REDUCE plate_number confidence significantly (≤0.7). A partial read flagged as incomplete is far better than a false-confident truncated read.

⚠️ COMMON MODEL ERROR — DO NOT DO THIS: reading "V [gap] X [gap] D" and returning plate_number_formatted="VXD". That collapses real spaces. The correct output is plate_number_formatted="V X D", separators=["full-space"].

SPACING IS FIRST-CLASS: Before transcribing, inspect the gaps between every adjacent character.
- A FULL SPACE is a clearly visible gap (roughly 1 character wide) between groups. e.g. "V X D" has full spaces → plate_number="VXD", plate_number_formatted="V X D", separators=["full-space"].
- A HALF-SPACE is a gap slightly wider than normal kerning but narrower than a full space. e.g. "MY COAST" (tight gap) → plate_number="MYCOAST", plate_number_formatted="MY·COAST", separators=["half-space"].
- DO NOT collapse spaces. If you see gaps between characters, report them. Concatenating "V X D" into "VXD" with no separator is WRONG.
- plate_number always contains ONLY alphanumeric characters (no spaces, dots, or dashes).
- plate_number_formatted encodes the spacing with the correct separator character.

STEP 4 — EXPIRATION
Look at the top-left and top-right corners for small colored rectangular STICKER TABS.
- Month sticker: usually top-left, shows month abbreviation (JAN, FEB, etc.) or number
- Year sticker: usually top-right, shows 2 or 4 digit year

IMPORTANT: Month and year stickers are SEPARATE physical tabs — a plate may have one, both, or neither.
- Report each sticker independently based on what you SEE.
- The month sticker (top-left) is common — read it if you can see any text or abbreviation on it.
- The year sticker (top-right) is sometimes MISSING. If the top-right corner has no colored tab — just blank plate surface — set expiration_year to null. Do NOT infer or guess a year from the month or any other context.

Convert month abbreviations: JAN=1 FEB=2 MAR=3 APR=4 MAY=5 JUN=6 JUL=7 AUG=8 SEP=9 OCT=10 NOV=11 DEC=12.
Month/year go ONLY in expiration_month and expiration_year — NEVER in vertical_text.
For the year: report the number you see as an integer (2-digit OK, system converts automatically).
Extract "expiration_sticker_color": <color of the year sticker if visible — null if NO year sticker present>.

STEP 5 — SPACING AND SYMBOLS
Inspect every gap between adjacent characters. Classify separators:
- FULL SPACE (U+0020): wide visible gap. → "full-space"
- HALF-SPACE (U+00B7 ·): gap wider than kerning but no physical dot. Common on vanity plates. → "half-space"
- BULLET (U+2022 •): a physical raised/printed dot between groups. Example: Arizona 1996 standard plates 669•ZHB. → "bullet"
- HYPHEN (-): printed dash. → "hyphen"
- NONE: uniform kerning only.

CRITICAL — separator_source:
- "design": separator is on EVERY plate of this design type (template-imposed). Not part of the assigned number.
- "assigned": separator is specific to this plate number (owner/state chosen). Removing it changes the number.
- "mixed" / null as appropriate.

CONFIDENCE: plate_number confidence = character identity certainty only. Separator uncertainty does NOT reduce it.

WORKED EXAMPLE: Arizona 1996 plate "669 • ZHB" (raised dot between groups):
  plate_number="669ZHB", plate_number_formatted="669•ZHB", separators=["bullet"], separator_source="design"

WORKED EXAMPLE: California vanity "MY COAST" (gap between MY and COAST):
  plate_number="MYCOAST", plate_number_formatted="MY·COAST", separators=["half-space"], separator_source="assigned"

symbols_in_lpn: ONLY symbols in a character slot (same baseline/size as letters/digits). Dot/bullet separators and background art are NOT symbols_in_lpn.
Use [] if you clearly assessed the plate and found none. Use null if image quality prevented assessment.
${taxonomySection}
Output ONLY valid JSON (no markdown, no code fences):

{
  "plate_number": "<Step 3 — center alphanumeric only>",
  "plate_number_formatted": "<Step 5 — exact separator encoding>",
  "separators": ["<must match plate_number_formatted: full-space | half-space | bullet | hyphen | none>"],
  "separator_source": "<assigned | design | mixed | null — 'design' if separator is a design-template element on every plate of this type; 'assigned' if it is part of the specific plate number itself; 'mixed' if both; null if none>",
  "spacing_notes": "<mixed/ambiguous only — otherwise null>",
  "symbols_in_lpn": <[] if confirmed none, null if uncertain, or array of strings>,
  "state": "<full state name>",
  "design_type": "<exact official plate type name from Step 6 taxonomy, or free description if state not in list>",
  "design": {
    "background": "<solid|gradient|scenic>",
    "colors": ["<primary>", "<secondary>"],
    "font_style": "<script|block|mixed>",
    "state_name_position": "<top|bottom|none>",
    "state_name_style": "<cursive|block|none>",
    "variant_hint": "<design series identifier — e.g. az_standard_1996_legacy (raised bullet separator, Grand Canyon design), az_standard_current (post-2008 screened, no bullet), ca_standard_2020, ca_legacy_gold, or null if unknown>"
  },
  "expiration_month": <integer 1-12 or null>,
  "expiration_year": <4-digit integer or null>,
  "expiration_sticker_color": "<color or null>",
  "is_disabled": <true or false>,
  "dp_logo_position": "<left | right | none>",
  "vertical_text": "<Step 1 — null if none or uncertain>",
  "vertical_text_type": "<plate_suffix | state_name | decorative | null — plate_suffix means it encodes a plate category like DP or DV>",
  "vertical_text_position": "<left | right | null — null when no vertical text>",
  "potentially_truncated": <true if any plate edge is cropped in the image and characters may be missing; false otherwise>,
  "confidence": {
    "plate_number": <0.0-1.0 — lower for: skewed/angled image, weathering, blur, occlusion, truncation; cropped/truncated plates should not exceed 0.7>,
    "expiration_month": <0.0-1.0, or null if expiration_month is null>,
    "expiration_year": <0.0-1.0, or null if expiration_year is null>,
    "vertical_text": <0.0-1.0, or null if vertical_text is null>
  }
}`

      try {
        let result1 = await callModel(prompt1, modelId, apiBase, { signal: activeAbort?.signal });
        let { parsed: data, jsonStr } = result1;
        if (result1.tokenUsage) {
          tokenTracker.passes.push({ pass: 1, ...result1.tokenUsage });
          tokenTracker.total_prompt += result1.tokenUsage.prompt || 0;
          tokenTracker.total_completion += result1.tokenUsage.completion || 0;
          tokenTracker.total += result1.tokenUsage.total || 0;
        }
        data = postProcess(data);
        
        let needSecondPass = false;
        const conf = data.confidence?.plate_number ?? 1;

        // Second pass triggers — each condition means a focused re-read can add value:
        // 1. Model is not confident about plate characters
        if (conf < 0.7) needSecondPass = true;
        // 2. Expiration data missing — re-pass focuses specifically on corner stickers
        const hasMixedChars = data.plate_number && /[A-Z]/i.test(data.plate_number) && /[0-9]/.test(data.plate_number);
        if ((data.expiration_month === null || data.expiration_year === null) && hasMixedChars) needSecondPass = true;
        
        if (needSecondPass) {
          updateStatus(1);
          
          const expiMissing = data.expiration_month === null || data.expiration_year === null;
          const prompt2 = `This is a ${data.state || 'unknown state'} license plate image.
Previous read: plate_number=${data.plate_number}.

${expiMissing ? `PRIORITY TASK — EXPIRATION STICKERS:
Look SPECIFICALLY at the TOP-LEFT and TOP-RIGHT corners of the plate for small colored sticker tabs.
- Top-left sticker: usually shows the expiration MONTH (e.g. "OCT", "NOV", a number 1-12)
- Top-right sticker: usually shows the expiration YEAR (often just 2 digits, e.g. "15" = 2015, "26" = 2026)
These stickers are small but distinct. Even if the image has some distortion, try to read them.
Report ONLY the digits/text you can see — do NOT return null just because the number is 2 digits.` : ''}

Also confirm the plate_number is correct.

Reply ONLY with JSON:
{
  "plate_number": "<same or corrected>",
  "plate_number_formatted": "<formatted>",
  "expiration_month": <integer 1-12 or null if truly not visible>,
  "expiration_year": <integer, 2-digit OK e.g. 15 or 26, or null if truly not visible>,
  "confidence": { "plate_number": <0.0-1.0> }
}`;
          const { parsed: data2 } = await callModel(prompt2, modelId, apiBase, { signal: activeAbort?.signal });
          
          // post-process second pass
          const conf2 = data2.confidence?.plate_number ?? 0;
          if (conf2 > conf) {
            data.plate_number = data2.plate_number || data.plate_number;
            data.plate_number_formatted = data2.plate_number_formatted || data.plate_number_formatted;
          }
          if (data2.expiration_month !== undefined) data.expiration_month = data2.expiration_month;
          if (data2.expiration_year !== undefined) data.expiration_year = data2.expiration_year;
          if (data2.confidence && data.confidence) {
             data.confidence.plate_number = Math.max(data.confidence.plate_number, conf2);
          }
          
          data = postProcess(data); // Re-run to handle formatting, bleed strip on the potentially new plate_number
          
        }

        // Pass 1b: spacing verification — fires when no separators detected.
        // Pass 1b: spacing verification — bidirectional (can add OR remove full-space separators).
        // Fires when:
        //   (a) formatted already has spaces (verify model's claim — catches false positives like 64989 K4)
        //   (b) short plate (≤5 chars) with no separators (catch missed spaces like V X D)
        // Does NOT fire for · or • separators — those are visually distinctive and trusted.
        const _fmtHasSpaces = data.plate_number_formatted && data.plate_number_formatted.includes(' ');
        // Only trigger short-plate spacing check for plates with letters (potential vanity plates).
        // Pure-digit sequential plates don't have assigned spacing — checking them causes hallucinated per-char spaces.
        const _hasLetters = data.plate_number && /[A-Z]/i.test(data.plate_number);
        const _shortNoSeps  = _hasLetters && data.plate_number.length <= 5
                              && data.separators && data.separators.includes('none');
        if ((_fmtHasSpaces || _shortNoSeps) && data.plate_number) {
          try {
            const spacePrompt = `You are examining a license plate. The characters were read as: ${data.plate_number}

TASK — look ONLY at the gaps between adjacent characters:
Is any gap CLEARLY wider than the space you would see inside the letter "O" on this same plate?

Answer strictly: true = YES there are wide visible gaps that are full-space separators.
false = NO, all gaps are normal character spacing (no separator).

Reply ONLY with this JSON (no markdown, no explanation):
{"has_space_separators": true|false, "plate_number_formatted": "<plate_number with single spaces between groups if true — exact plate_number string if false>"}`;
            const { parsed: spData } = await callModel(spacePrompt, modelId, apiBase, { signal: activeAbort?.signal });
            if (spData.has_space_separators === true && spData.plate_number_formatted) {
              // Model confirms spaces — apply if sanity check passes
              const fmt = spData.plate_number_formatted.trim();
              if (fmt.replace(/\s/g, '').toUpperCase() === data.plate_number.toUpperCase() && fmt !== data.plate_number) {
                data.plate_number_formatted = fmt;
                data.separators = ['full-space'];
                data.separator_source = data.separator_source || 'assigned';
              }
            } else if (spData.has_space_separators === false) {
              // Model denies spaces — strip any that the main pass added
              data.plate_number_formatted = data.plate_number;
              data.separators = ['none'];
              data.separator_source = null;
            }
          } catch (e) { /* non-fatal */ }
        }

        // Pass 2a/2b: dedicated sticker reads — one crop per call, ultra-focused prompts.
        // Splitting month and year into separate calls prevents the model from confusing
        // two images in one request and hallucinating the year from context.
        if (data.expiration_month === null || data.expiration_year === null) {
          updateStatus(2);
          try {
            const [leftCrop, rightCrop] = await Promise.all([
              cropCorner(imageBase64, 'left', 0.38, 0.35, 4),
              cropCorner(imageBase64, 'right', 0.38, 0.35, 4)
            ]);
            if (!data.confidence) data.confidence = {};

            // 2a: month sticker — left corner crop, contrast-enhanced
            if (data.expiration_month === null) {
              const monthPrompt = `This is a zoomed crop of a license plate corner.
Look for a small colored sticker tab. Month stickers typically show a 3-letter abbreviation (JAN, FEB, MAR, APR, MAY, JUN, JUL, AUG, SEP, OCT, NOV, DEC) or a number 1-12.

The sticker may be small and partially worn. Read whatever text you can see on it.
If there is genuinely no sticker at all, return sticker_visible=false.

Reply ONLY with JSON: {"sticker_visible": true|false, "raw": "<exactly what you see or null>", "month": <integer 1-12 or null>, "confidence": <0.0-1.0>}`;
              const { parsed: mData } = await callModel(monthPrompt, modelId, apiBase,
                { signal: activeAbort?.signal, imageOverride: leftCrop });
              const conf = mData.confidence ?? 0;
              if (mData.sticker_visible === true && mData.month != null && conf >= 0.5) {
                data.expiration_month = mData.month;
                data.confidence.expiration_month = Math.min(0.85, conf);
              }
            }

            // 2a-fallback: if left corner didn't find month, try right corner too
            if (data.expiration_month === null) {
              try {
                const { parsed: mData2 } = await callModel(monthPrompt, modelId, apiBase,
                  { signal: activeAbort?.signal, imageOverride: rightCrop });
                const conf2 = mData2.confidence ?? 0;
                if (mData2.sticker_visible === true && mData2.month != null && conf2 >= 0.5) {
                  data.expiration_month = mData2.month;
                  data.confidence.expiration_month = Math.min(0.85, conf2);
                }
              } catch (e) { /* non-fatal */ }
            }

            // 2b: year sticker — right corner crop
            // Anti-hallucination: require sticker_visible=true before accepting a year.
            if (data.expiration_year === null) {
              const yearPrompt = `Look at this zoomed image of a license plate corner.
Is there a small colored STICKER with a number on it? Stickers are small rectangular tabs, usually a distinct color (red, blue, green, yellow).

CRITICAL: If there is NO sticker visible — just blank plate background or plate characters — you MUST return sticker_visible=false and year=null.
Do NOT guess. Do NOT infer a year from context. Only return a year if you see an actual sticker with digits printed on it.

Reply ONLY with JSON: {"sticker_visible": true|false, "raw": "<digits as printed or null>", "year": <integer or null>, "confidence": <0.0-1.0>}`;
              const { parsed: yData } = await callModel(yearPrompt, modelId, apiBase,
                { signal: activeAbort?.signal, imageOverride: rightCrop });
              if (yData.sticker_visible === true && yData.year != null && (yData.confidence ?? 0) >= 0.5) {
                data.expiration_year = yData.year;
                data.confidence.expiration_year = Math.min(0.85, yData.confidence ?? 0.6);
              }
            }

            data = postProcess(data);
          } catch(e) { /* non-fatal */ }
        }

        // Pass 3: design classification — only if we have a known state with taxonomy
        const taxSection = buildTaxonomySection(data.state);
        if (taxSection) {
          updateStatus(3);
          // Feed pass 1 context into pass 3 so the model doesn't lose what it already detected
          const pass1Hint = data.design?.variant_hint ? `\nPass 1 detected variant_hint: "${data.design.variant_hint}". Use this as a strong signal — if it matches a design_type in the list below, prefer it over generic types like "Standard Passenger Vehicle".` : '';
          const pass1Design = data.design_type ? `\nPass 1 classified design_type as: "${data.design_type}".` : '';
          const promptDesign = `This is a ${data.state} license plate. Plate number: ${data.plate_number}.${pass1Design}${pass1Hint}

Your job: classify the EXACT design_type from the taxonomy list below. Pay close attention to visual elements — background art, colors, icons, and any special graphics. A plate with ocean/whale/wave art is NOT "Standard Passenger Vehicle" even if the base layout looks standard.
${taxSection}
Reply ONLY with JSON: {"design_type":"<exact name from list>","design":{"background":"<solid|gradient|scenic>","colors":["<primary>","<secondary>"],"font_style":"<script|block|mixed>","state_name_position":"<top|bottom|none>","state_name_style":"<cursive|block|none>","variant_hint":"<variant or null>"}}`;
          try {
            const { parsed: dData } = await callModel(promptDesign, modelId, apiBase, { signal: activeAbort?.signal });
            if (dData.design_type) data.design_type = dData.design_type;
            if (dData.design)      data.design      = dData.design;
            data = postProcess(data); // re-run to normalize design_type + derive disabled_type
          } catch (e) { /* non-fatal — keep pass 1 design_type */ }
          updateStatus(4);
        }

        // Pass 4: Edge crop for vertical text — runs when plate is disabled but suffix wasn't read.
        // Makes ONE call per side with a simple yes/no prompt to avoid image-order confusion.
        if (data.is_disabled && !data.vertical_text) {
          updateStatus(4);
          const singleEdgePrompt = `This is a zoomed crop from one side of a disabled license plate.

Look for two letters stacked vertically (one on top of the other). They are:
- SMALLER than the main plate number characters
- Positioned near the wheelchair ♿ icon
- Usually "D" on top and "P" or "V" on bottom

CRITICAL: If you do NOT see two small stacked letters distinct from the main plate number, return visible=false. Do NOT guess.

Reply ONLY with JSON:
{"visible": true|false, "text": "<e.g. DP or DV, or null if not visible>", "confidence": <0.0-1.0>}`;

          try {
            const [leftEdge, rightEdge] = await Promise.all([
              cropEdge(imageBase64, 'left'),
              cropEdge(imageBase64, 'right')
            ]);

            // Call each side independently — eliminates image-order confusion
            const [leftResult, rightResult] = await Promise.all([
              callModel(singleEdgePrompt, modelId, apiBase, { signal: activeAbort?.signal, imageOverride: leftEdge })
                .then(r => r.parsed).catch(() => null),
              callModel(singleEdgePrompt, modelId, apiBase, { signal: activeAbort?.signal, imageOverride: rightEdge })
                .then(r => r.parsed).catch(() => null)
            ]);

            // Pick the side that found valid text with higher confidence
            const VALID_SUFFIXES = new Set(['DP','DV','DPE','DVE']);
            const candidates = [];
            if (leftResult?.visible && leftResult.text && VALID_SUFFIXES.has(leftResult.text.toUpperCase().trim())) {
              candidates.push({ ...leftResult, text: leftResult.text.toUpperCase().trim(), position: 'left' });
            }
            if (rightResult?.visible && rightResult.text && VALID_SUFFIXES.has(rightResult.text.toUpperCase().trim())) {
              candidates.push({ ...rightResult, text: rightResult.text.toUpperCase().trim(), position: 'right' });
            }

            if (candidates.length > 0) {
              // Take highest confidence, or first if tied
              const best = candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
              data.vertical_text = best.text;
              data.vertical_text_position = best.position?.toLowerCase().includes('left') ? 'left' : best.position?.toLowerCase().includes('right') ? 'right' : null;
              data.vertical_text_type = 'plate_suffix';
              if (!data.confidence) data.confidence = {};
              data.confidence.vertical_text = best.confidence ?? 0.7;
              const SUFFIX_MAP = { 'DP': 'Disabled Person', 'DV': 'Disabled Veteran', 'DPE': 'Disabled Person (Exempt)', 'DVE': 'Disabled Veteran (Exempt)' };
              data.disabled_type = SUFFIX_MAP[data.vertical_text] || data.disabled_type;
            }

            // Fallback: if edge crops didn't find anything, try the full plate image
            if (!data.vertical_text) {
              const fullPlatePrompt = `This is a California disabled license plate with a wheelchair ♿ icon.
Somewhere on this plate there are two small letters stacked vertically: either "DP" or "DV".
They are SMALLER than the main plate number and positioned to the left or right of it.

Look at the area between the wheelchair icon and the main plate number.
Also look at the right side of the plate after the last digit.

Do you see "DP" or "DV"? Which side of the plate number is it on?

Reply ONLY with JSON:
{"text": "<DP or DV or null>", "position": "<left or right of plate number>", "confidence": <0.0-1.0>}`;
              try {
                const { parsed: fbData } = await callModel(fullPlatePrompt, modelId, apiBase, { signal: activeAbort?.signal });
                if (fbData.text && ['DP','DV','DPE','DVE'].includes(fbData.text.toUpperCase().trim())) {
                  data.vertical_text = fbData.text.toUpperCase().trim();
                  data.vertical_text_position = fbData.position?.toLowerCase().includes('left') ? 'left' : fbData.position?.toLowerCase().includes('right') ? 'right' : null;
                  data.vertical_text_type = 'plate_suffix';
                  if (!data.confidence) data.confidence = {};
                  data.confidence.vertical_text = Math.min(fbData.confidence ?? 0.6, 0.8);
                  const SUFFIX_MAP2 = { 'DP': 'Disabled Person', 'DV': 'Disabled Veteran', 'DPE': 'Disabled Person (Exempt)', 'DVE': 'Disabled Veteran (Exempt)' };
                  data.disabled_type = SUFFIX_MAP2[data.vertical_text] || data.disabled_type;
                }
              } catch (e2) { /* non-fatal */ }
            }
          } catch (e) { /* non-fatal */ }
        }
        // Pass 5: Verification — show the model its own analysis alongside the image and ask it to verify/correct
        updateStatus(5);

        // Snapshot pre-verification state for discordance detection
        const preVerify = {
          plate_number: data.plate_number,
          plate_number_formatted: data.plate_number_formatted,
          separators: JSON.parse(JSON.stringify(data.separators || [])),
          state: data.state,
          design_type: data.design_type,
          expiration_month: data.expiration_month,
          expiration_year: data.expiration_year,
          is_disabled: data.is_disabled,
          vertical_text: data.vertical_text,
          vertical_text_position: data.vertical_text_position,
          potentially_truncated: data.potentially_truncated
        };

        try {
          const verifyFields = { ...preVerify };
          const verifyPrompt = `You are verifying a license plate analysis. Look at the plate image carefully, then compare it against the analysis below.

CURRENT ANALYSIS:
${JSON.stringify(verifyFields, null, 2)}

VERIFICATION CHECKLIST — check each item against the actual image:
1. PLATE NUMBER: Are ALL characters correct? Count them. Check for confused characters (0/O, 1/I/L, 5/S, 8/B, 2/Z). Is anything missing or extra?
2. SPACING: Does plate_number_formatted match the ACTUAL gaps visible on the plate? Are spaces real or hallucinated? For standard sequential plates (e.g. "1ABC234"), there should typically be NO spaces.
3. STATE: Is the state identification correct based on plate design/text?
4. DESIGN TYPE: Does "${data.design_type || 'unknown'}" accurately describe this plate's visual design? Look for special art, graphics, or distinctive features.
5. EXPIRATION: Do the month/year match visible sticker tabs in the corners? Are stickers actually present?
6. DISABLED: Is there a wheelchair/ISA symbol? Is is_disabled correct?
7. VERTICAL TEXT: If the plate has edge text (DP/DV), is it captured correctly?
8. TRUNCATION: Is any edge of the plate cropped in the image?

For each field, either confirm it's correct or provide the corrected value.
If EVERYTHING is correct, return the same values unchanged.

CRITICAL RULES:
- Do NOT null out values that were previously detected unless you are CERTAIN they are wrong. If the first pass found expiration_month=11, only change it if you can clearly see a DIFFERENT month — do not set it to null just because the sticker is hard to read.
- Do NOT change potentially_truncated to true unless you can clearly see a cropped edge with missing characters.
- Your job is to CATCH ERRORS, not second-guess uncertain-but-reasonable reads.

Reply ONLY with JSON:
{
  "plate_number": "<confirmed or corrected>",
  "plate_number_formatted": "<confirmed or corrected>",
  "separators": [<confirmed or corrected>],
  "state": "<confirmed or corrected>",
  "design_type": "<confirmed or corrected>",
  "expiration_month": <confirmed or corrected or null>,
  "expiration_year": <confirmed or corrected or null>,
  "is_disabled": <confirmed or corrected>,
  "vertical_text": "<confirmed or corrected or null>",
  "vertical_text_position": "<confirmed or corrected or null>",
  "potentially_truncated": <confirmed or corrected>,
  "corrections_made": ["<list each field that was changed, or empty array if none>"],
  "confidence": {
    "plate_number": <0.0-1.0>,
    "expiration_month": <0.0-1.0 or null>,
    "expiration_year": <0.0-1.0 or null>,
    "vertical_text": <0.0-1.0 or null>
  }
}`;
          const { parsed: vData } = await callModel(verifyPrompt, modelId, apiBase, { signal: activeAbort?.signal });

          // Apply corrections — only override fields that were explicitly changed
          const corrections = vData.corrections_made || [];
          if (corrections.length > 0) {
            console.log('[Platez] Verification corrections:', corrections);
          }

          // Apply verified values with protection: verification can CORRECT but not ERASE,
          // UNLESS it has high confidence that the original value was wrong.
          // PLZ-03: Allow null-outs when verify confidence ≥ 0.85 AND original confidence ≤ 0.6
          const nullOutLog = [];

          // Map fields to their confidence keys
          const CONF_KEY_MAP = {
            expiration_month: 'expiration_month',
            expiration_year: 'expiration_year',
            vertical_text: 'vertical_text',
            vertical_text_position: 'vertical_text'  // shares confidence with vertical_text
          };

          function applyVerified(key, verVal) {
            const preVal = preVerify[key];

            // Null-out attempt: pre-verify had a value, verify wants to erase it
            if (preVal != null && verVal == null) {
              const confKey = CONF_KEY_MAP[key];
              const origConf = confKey ? (data.confidence?.[confKey] ?? 1.0) : 1.0;
              const verConf = confKey ? (vData.confidence?.[confKey] ?? 0) : 0;

              // PLZ-03 carve-out: allow null-out if verify is highly confident AND original was low
              if (verConf >= 0.85 && origConf <= 0.6) {
                nullOutLog.push({ field: key, before: preVal, after: null, origConf, verConf, action: 'allowed' });
                data[key] = verVal;
                return;
              }

              // Otherwise block the null-out
              nullOutLog.push({ field: key, before: preVal, after: null, origConf, verConf, action: 'blocked' });
              return;
            }

            // Reject false→true on truncation without strong reason
            if (key === 'potentially_truncated' && preVal === false && verVal === true) return;
            data[key] = verVal;
          }

          if (vData.plate_number) applyVerified('plate_number', vData.plate_number);
          if (vData.plate_number_formatted) applyVerified('plate_number_formatted', vData.plate_number_formatted);
          if (Array.isArray(vData.separators)) applyVerified('separators', vData.separators);
          if (vData.state) applyVerified('state', vData.state);
          if (vData.design_type) applyVerified('design_type', vData.design_type);
          if (vData.expiration_month !== undefined) applyVerified('expiration_month', vData.expiration_month);
          if (vData.expiration_year !== undefined) applyVerified('expiration_year', vData.expiration_year);
          if (vData.is_disabled !== undefined) applyVerified('is_disabled', vData.is_disabled);
          if (vData.vertical_text !== undefined) applyVerified('vertical_text', vData.vertical_text);
          if (vData.vertical_text_position !== undefined) applyVerified('vertical_text_position', vData.vertical_text_position);
          if (vData.potentially_truncated !== undefined) applyVerified('potentially_truncated', vData.potentially_truncated);
          // Merge per-field confidence from verification pass
          if (vData.confidence) {
            if (vData.confidence.plate_number != null)
              data.confidence.plate_number = Math.max(data.confidence?.plate_number || 0, vData.confidence.plate_number);
            if (vData.confidence.expiration_month != null && data.expiration_month != null)
              data.confidence.expiration_month = vData.confidence.expiration_month;
            if (vData.confidence.expiration_year != null && data.expiration_year != null)
              data.confidence.expiration_year = vData.confidence.expiration_year;
            if (vData.confidence.vertical_text != null && data.vertical_text != null)
              data.confidence.vertical_text = vData.confidence.vertical_text;
          }

          // Re-run post-processing to normalize any corrected values
          data = postProcess(data);

          // Compute discordance — compare pre-verification snapshot to final values
          const discordance = [];
          const trackFields = ['plate_number','plate_number_formatted','separators','state','design_type',
            'expiration_month','expiration_year','is_disabled','vertical_text','vertical_text_position','potentially_truncated'];
          for (const key of trackFields) {
            const before = preVerify[key];
            const after = data[key];
            const bStr = JSON.stringify(before ?? null);
            const aStr = JSON.stringify(after ?? null);
            if (bStr !== aStr) {
              discordance.push({ field: key, before: before ?? null, after: after ?? null });
            }
          }

          // PLZ-01: Classify each discordance with a failure_type
          const CONFUSABLE_CHARS = new Set(['0','O','1','I','L','5','S','8','B','2','Z']);
          function classifyFailure(d) {
            const { field, before, after } = d;
            if (field === 'plate_number' && before && after) {
              // Check if it's character confusion (same length, differ only in confusable chars)
              const b = String(before).toUpperCase(), a = String(after).toUpperCase();
              if (b.length === a.length) {
                const diffs = [...b].filter((c, i) => c !== a[i]);
                if (diffs.length > 0 && diffs.every(c => CONFUSABLE_CHARS.has(c))) return 'char_confusion';
              }
              // Length difference could be bleed not stripped
              if (Math.abs(b.length - a.length) <= 2) return 'bleed_not_stripped';
            }
            if (field === 'vertical_text') {
              if (before == null && after != null) return 'vertical_text_missed';
              if (before != null && after == null) return 'vertical_text_hallucinated';
            }
            if (field === 'expiration_month' || field === 'expiration_year') {
              if (before == null && after != null) return 'sticker_missed';
              if (before != null && after == null) return 'sticker_hallucinated';
              if (before != null && after != null) return 'sticker_misread';
            }
            if (field === 'design_type') return 'design_misclassified';
            if (field === 'plate_number_formatted' || field === 'separators') return 'spacing_error';
            return 'other';
          }

          discordance.forEach(d => { d.failure_type = classifyFailure(d); });

          data._verification = {
            corrections_reported: corrections,
            discordance: discordance,
            null_outs: nullOutLog.length > 0 ? nullOutLog : undefined,
            verified: discordance.length === 0
          };

          if (discordance.length > 0) {
            console.log('[Platez] Discordance detected:', discordance);
          }
          if (nullOutLog.length > 0) {
            console.log('[Platez] Null-out decisions:', nullOutLog);
          }
        } catch (e) {
          console.warn('[Platez] Verification pass failed (non-fatal):', e.message);
          data._verification = { skipped: true, error: e.message };
        }

        updateStatus(6);

        // Fade out the pipeline step box after completion — it's noise once results are shown
        setTimeout(() => { statusMsg.style.opacity = '0'; }, 800);
        setTimeout(() => {  statusMsg.style.opacity = '1'; }, 1600);

        // Log the run to server (route through remote proxy when not local)
        const logEntry = { 
          ...data, 
          _timestamp: new Date().toISOString(), 
          _provider: providerSelect.value, 
          _model: modelId, 
          _tokenUsage: tokenTracker,
          _image_base64: imageBase64,
          _image_mime: imageMime
        };
        const isLocal = window.location.hostname.match(/localhost|127\.|192\.168\./);
        const logUrl = isLocal ? '/log' : '/Platez/log';
        fetch(logUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(logEntry) })
          .catch(e => console.warn('[Platez] Log failed:', e));
        console.log('[Platez] Run result:', logEntry);

        // Save to history for re-testing
        addToHistory(imageBase64, imageMime, data.plate_number_formatted || data.plate_number);

        // Store for feedback attachment
        lastRunData = data;
        document.getElementById('feedback-text').value = '';
        
        

        return data;
    } catch(err) { throw err; }
  } // end extractPlateData

'AbortError') {
          statusMsg.textContent = 'Cancelled.';
          
        } else {
          showError(err.message);
        }
      } finally {
        clearTimeout(timeoutId);
        activeAbort = null;
        
        
        analyzeBtn.textContent = 'Analyze Plate';
      }
    }

    const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const CHROME_LABELS = new Set(["MO", "YR", "MO YR", "MONTH", "YEAR", "STATE", "LICENSE", "LICENSE PLATE", "REG", "REG."]);

    function postProcess(data) {
      const nullish = new Set(['null','n/a','na','none','']);

      // 1. Normalize null-like strings
      ['spacing_notes','vertical_text','plate_number','plate_number_formatted','dp_logo_position','vertical_text_position','design_type','expiration_sticker_color','separator_source']
        .forEach(k => { if (nullish.has(String(data[k]||'').toLowerCase().trim())) data[k] = null; });

      if (data.confidence == null) data.confidence = {};

      // No hard ceiling on plate_number confidence — model self-assesses per degradation prompt.
      // Expiration fields come from small corner stickers (inherently harder to read than the main LPN),
      // so cap them at 0.90 regardless of model confidence.
      for (const k of ['expiration_month', 'expiration_year']) {
        if (typeof data.confidence?.[k] === 'number') {
          data.confidence[k] = Math.min(data.confidence[k], 0.90);
        }
      }

      // Confidence: trust the model's self-assessment entirely.
      // The model is explicitly prompted to reduce confidence for degraded/ambiguous images.
      // Post-processing penalties were causing false low-confidence on clean plates (e.g. BME5848).
      if (data.confidence?.plate_number !== undefined) {
        data.confidence.plate_number = Math.max(0, Math.min(1, data.confidence.plate_number));
      }

      // 2. dp_logo_position default
      if (!data.dp_logo_position) data.dp_logo_position = 'none';

      // 3. Infer is_disabled from dp_logo_position
      if (data.dp_logo_position !== 'none') data.is_disabled = true;

      // 4. Normalize vertical_text_position to "left", "right", or null
      if (data.vertical_text_position && typeof data.vertical_text_position === 'string') {
        const vtp = data.vertical_text_position.toLowerCase();
        if (vtp.includes('left')) data.vertical_text_position = 'left';
        else if (vtp.includes('right')) data.vertical_text_position = 'right';
        else data.vertical_text_position = null;
      }
      if (!['left','right'].includes(data.vertical_text_position)) data.vertical_text_position = null;

      // 5a. Strip parenthetical annotations from expiration_year (model sometimes appends
      // sticker color or other metadata: "15 (black)" → "15", "2015 (blue)" → 2015)
      if (typeof data.expiration_year === 'string') {
        data.expiration_year = data.expiration_year.replace(/\s*\(.*?\)\s*/g, '').trim();
      }
      if (typeof data.expiration_month === 'string') {
        data.expiration_month = data.expiration_month.replace(/\s*\(.*?\)\s*/g, '').trim();
      }
      // Normalize 2-digit year → 4-digit (stickers often show "10" meaning 2010)
      if (typeof data.expiration_year === 'number' &&
          data.expiration_year >= 0 && data.expiration_year <= 99) {
        data.expiration_year = 2000 + data.expiration_year;
      }
      // Also handle string years like "10" or "2010"
      if (typeof data.expiration_year === 'string') {
        const yn = parseInt(data.expiration_year.trim(), 10);
        if (!isNaN(yn)) data.expiration_year = yn >= 100 ? yn : 2000 + yn;
        else data.expiration_year = null;
      }

      // 5. Normalize expiration_month string → integer
      if (typeof data.expiration_month === 'string') {
        const key = data.expiration_month.toLowerCase().slice(0, 3);
        data.expiration_month = MONTH_MAP[key] ?? null;
      }

      // STRIP PLATE CHROME LABELS
      if (data.vertical_text && CHROME_LABELS.has(data.vertical_text.toUpperCase())) {
         data.vertical_text = null;
         data.vertical_text_position = null;
      }

      // Strip state name misclassified as vertical text (horizontal design element, not rotated 90°)
      if (data.vertical_text && data.state) {
        const vtNorm = data.vertical_text.trim().toLowerCase();
        const stNorm = data.state.trim().toLowerCase();
        if (vtNorm === stNorm || vtNorm === stNorm.replace(/\s+/g, '')) {
          data._rejected_vertical_text = data.vertical_text;
          data._rejected_vertical_text_reason = 'state_name_horizontal';
          data.vertical_text = null;
          data.vertical_text_position = null;
        }
      }

      // HARD FILTER: Only allow known plate suffix markers (DP, DV, DPE, DVE) as vertical text.
      // Everything else is rejected, nulled out, and preserved for manual review logging.
      const VALID_VERTICAL_TEXT = new Set(['DP','DV','DPE','DVE']);
      if (data.vertical_text && !VALID_VERTICAL_TEXT.has(data.vertical_text.toUpperCase().trim())) {
        console.warn('[Platez] Rejected vertical_text for manual review:', data.vertical_text, '| type:', data.vertical_text_type);
        data._rejected_vertical_text = data.vertical_text;
        data._rejected_vertical_text_reason = 'not_plate_suffix';
        data.vertical_text = null;
        data.vertical_text_position = null;
      }

      // 6. Move month/year out of vertical_text FIRST (before bleed strip runs)
      if (data.vertical_text) {
        const vt = data.vertical_text.trim();
        const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(vt);
        const hasYear  = /\b(20\d{2})\b/.test(vt);
        if (hasMonth || hasYear || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i.test(vt)) {
          const mM = vt.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
          const yM = vt.match(/\b(20\d{2})\b/);
          if (mM && !data.expiration_month) data.expiration_month = MONTH_MAP[mM[1].toLowerCase()];
          if (yM && !data.expiration_year)  data.expiration_year  = parseInt(yM[1]);
          data.vertical_text = null;
          data.vertical_text_position = null;
        }
      }

      // 7. Normalize plate_number_formatted
      if (data.plate_number_formatted) {
        data.plate_number_formatted = data.plate_number_formatted
          .replace(/U\+0020/g, ' ')
          .replace(/U\+00B7/g, '·')   // explicit literal → middle dot (half-space)
          .replace(/U\+2022/g, '•')   // explicit literal → bullet
          .replace(/\u2027/g, '');    // strip hyphenation point

        // If model used · but separators says "bullet", promote to • for correct derivation
        if (Array.isArray(data.separators) && data.separators.includes('bullet') &&
            !data.plate_number_formatted.includes('•') && data.plate_number_formatted.includes('·')) {
          data.plate_number_formatted = data.plate_number_formatted.replace(/·/g, '•');
        }

        // Only reset formatted if stripping separators gives something DIFFERENT from plate_number.
        // (= hallucinated content). Do NOT reset if they match — that's valid separator encoding.
        const noSep = data.plate_number_formatted.replace(/[\s·•\-]/g, '');
        if (data.plate_number && noSep.toUpperCase() !== data.plate_number.toUpperCase())
          data.plate_number_formatted = data.plate_number;
      }

      // 8. TIGHTEN DP BLEED STRIP (longest prefix that is suffix of vertical_text)
      if (data.is_disabled && data.plate_number) {
        const isMarker = v => v && /^[A-Z]{1,3}$/i.test(v.trim());
        const vtRaw = isMarker(data.vertical_text) ? data.vertical_text : 'DP';
        const dp = vtRaw.toUpperCase().replace(/\s/g, '');
        for (let len = dp.length; len >= 1; len--) {
          if (data.plate_number.toUpperCase().startsWith(dp.slice(-len))) {
            const stripped = data.plate_number.slice(len);
            if (stripped.length >= 3) {
              data.plate_number = stripped;
              if (data.plate_number_formatted)
                data.plate_number_formatted = data.plate_number_formatted.slice(len).replace(/^[\s·\-]+/, '');
            }
            break;
          }
        }
      }

      // 8b. SUFFIX BLEED STRIP — vertical_text chars that bled onto the END of plate_number
      // e.g. "00000D" with vertical_text="DV" → strip trailing "D" (prefix of "DV") → "00000"
      if (data.is_disabled && data.plate_number) {
        const isMarker2 = v => v && /^[A-Z]{1,3}$/i.test(v.trim());
        const vtRaw2 = isMarker2(data.vertical_text) ? data.vertical_text : 'DP';
        const dp2 = vtRaw2.toUpperCase().replace(/\s/g, '');
        for (let len = dp2.length; len >= 1; len--) {
          // Check if plate ends with the first `len` chars of the marker (prefix of marker = suffix bleed)
          if (data.plate_number.toUpperCase().endsWith(dp2.slice(0, len))) {
            const stripped = data.plate_number.slice(0, data.plate_number.length - len);
            if (stripped.length >= 3) {
              data.plate_number = stripped;
              if (data.plate_number_formatted) {
                data.plate_number_formatted = data.plate_number_formatted
                  .slice(0, data.plate_number_formatted.length - len)
                  .replace(/[\s·\-]+$/, '');
              }
            }
            break;
          }
        }
      }

      // 8c. Re-evaluate confidence after suffix/prefix strip on clean plates
      // Pure-letter or pure-digit plates have no inter-class ambiguity — confidence should be high
      if (data.plate_number && data.confidence) {
        const pn = data.plate_number;
        const hasBoth = /[A-Z]/i.test(pn) && /[0-9]/.test(pn);
        if (!hasBoth) {
          // No mixed characters: floor confidence at 0.9 unless model was extremely uncertain
          if (typeof data.confidence.plate_number === 'number') {
            data.confidence.plate_number = Math.max(data.confidence.plate_number, 0.9);
          } else {
            data.confidence.plate_number = 0.9;
          }
        }
      }

      // 9. Move month/year from vertical_text again (catches cases not caught in step 6)
      if (data.vertical_text) {
        const vt = data.vertical_text.trim();
        if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i.test(vt)) {
          const mM = vt.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
          const yM = vt.match(/\b(20\d{2})\b/);
          if (mM && !data.expiration_month) data.expiration_month = MONTH_MAP[mM[1].toLowerCase()];
          if (yM && !data.expiration_year)  data.expiration_year  = parseInt(yM[1]);
          data.vertical_text = null;
          data.vertical_text_position = null;
        }
      }

      // 10. Clear vertical_text if it duplicates plate_number
      if (data.vertical_text && data.plate_number &&
          data.vertical_text.replace(/[\s·\-]/g,'').toUpperCase() === data.plate_number.replace(/[\s·\-]/g,'').toUpperCase()) {
        data.vertical_text = null;
        data.vertical_text_position = null;
      }

      // 10b. Apply variant-level systematic separator rules
      // Design-level separators (imposed by plate design template on every plate of that type)
      // take precedence over model-inferred separator classification.
      // Source: _variantMeta in plate-types.json, keyed by design.variant_hint
      const variantHint = data.design?.variant_hint;
      const meta = variantHint ? variantMeta[variantHint] : null;
      if (meta && meta.systematic_separator && data.plate_number) {
        const sepChar = meta.systematic_separator_char || '•';
        const re = new RegExp(meta.plate_pattern, 'i');
        const m = data.plate_number.match(re);
        if (m && m[1] && m[2]) {
          // Pattern matched — apply design-level separator definitively
          data.plate_number_formatted = m[1] + sepChar + m[2];
          data.separator_source = 'design';
        }
      } else if (meta && meta.systematic_separator === null) {
        // Explicitly known: this design has NO systematic separator
        // Any separator present in the formatted string is part of the assigned number
        if (data.separators && !data.separators.includes('none')) {
          data.separator_source = 'assigned';
        }
      }
      // If separator_source not yet set by variant meta, keep model's value or normalize
      if (!data.separator_source || !['assigned','design','mixed'].includes(data.separator_source)) {
        data.separator_source = null;
      }
      // When no separators are present, source is always null — "design" with no separator is contradictory
      if (!data.separators || (data.separators.length === 1 && data.separators[0] === 'none')) {
        data.separator_source = null;
      }

      // 10c. Pattern-based spacing override — standard sequential plates never have spaces.
      // If the stripped plate_number matches a known sequential format, force no separators.
      if (data.plate_number && data.state) {
        const pn = data.plate_number.toUpperCase();
        const STATE_PATTERNS = {
          'California': [
            /^[0-9][A-Z]{3}[0-9]{3}$/,   // 1ABC234
            /^[A-Z]{3}[0-9]{4}$/,          // ABC1234
            /^[0-9]{4}[A-Z]{3}$/,          // 1234ABC
            /^[A-Z]{2}[0-9]{3,5}$/,        // CL818 (disabled format)
            /^[A-Z][0-9]{4,5}$/,           // R8042 (disabled format)
            /^[0-9]{5,7}$/,                 // 94451 (all digits)
            /^[0-9][A-Z]{3}[0-9]{2}$/,     // 1ABC23
          ],
          'Arizona': [
            /^[A-Z]{3}[0-9]{4}$/,          // ABC1234
            /^[0-9]{3}[A-Z]{3}$/,          // 123ABC (legacy with bullet handled by variant meta)
          ]
        };
        const patterns = STATE_PATTERNS[data.state];
        if (patterns && patterns.some(re => re.test(pn))) {
          // Known sequential format — no assigned separators of any kind
          if (data.plate_number_formatted) {
            data.plate_number_formatted = data.plate_number_formatted.replace(/[\s·•\-]/g, '');
          }
        }
      }

      // 10d. Detect hallucinated per-character spacing (e.g. "9 4 4 5 1" from "94451")
      // If every "group" is a single character, it's almost certainly hallucinated spacing.
      // Short all-letter plates (≤3 chars like "V X D") are exempt — those can be real vanity spacing.
      // Longer plates (4+ chars) with every group = 1 char are always collapsed.
      if (data.plate_number_formatted && data.plate_number) {
        const groups = data.plate_number_formatted.trim().split(/[\s·•]+/);
        const allSingleChar = groups.length > 2 && groups.every(g => g.replace(/[-]/g, '').length <= 1);
        const isShortVanity = !(/[0-9]/.test(data.plate_number)) && data.plate_number.length <= 3;
        if (allSingleChar && !isShortVanity) {
          data.plate_number_formatted = data.plate_number;
        }
      }

      // 10e. Enforce confidence cap on truncated plates
      if (data.potentially_truncated === true && data.confidence?.plate_number > 0.7) {
        data.confidence.plate_number = 0.7;
      }

      // 11. Derive separators from plate_number_formatted (source of truth)
      const fmt = data.plate_number_formatted || '';
      const seps = [];
      if (fmt.includes(' '))  seps.push('full-space');
      if (fmt.includes('·'))  seps.push('half-space');  // U+00B7 = visual gap only
      if (fmt.includes('•'))  seps.push('bullet');       // U+2022 = physical dot on plate
      if (fmt.includes('-'))  seps.push('hyphen');
      data.separators = seps.length ? seps : ['none'];

      // 11b. Force separator_source null when no separators present (re-check after pattern strips)
      if (data.separators.length === 1 && data.separators[0] === 'none') {
        data.separator_source = null;
      }

      // 12. Clean symbols_in_lpn (keeping null as null)
      if (Array.isArray(data.symbols_in_lpn)) {
        if (data.symbols_in_lpn.length === 0) {
           // empty array = confirmed none
        } else {
           data.symbols_in_lpn = data.symbols_in_lpn.filter(s => s && !nullish.has(s.toLowerCase().trim()) && !s.startsWith('<'));
        }
      } else if (data.symbols_in_lpn !== null) {
        data.symbols_in_lpn = null;
      }

      // 13. Remove vertical_text chars from symbols_in_lpn
      if (data.vertical_text && Array.isArray(data.symbols_in_lpn) && data.symbols_in_lpn.length) {
        const vtChars = new Set(data.vertical_text.toUpperCase().replace(/\s/g,'').split(''));
        data.symbols_in_lpn = data.symbols_in_lpn.filter(s => !vtChars.has(s.toUpperCase()));
      }

      // 14a. Sync vertical_text_position — always NA when no vertical text
      if (!data.vertical_text) data.vertical_text_position = null;

      // 14. Disabled plate with no vertical_text — do NOT default to "DP".
      // DP and DV have completely different meanings; the suffix must be read from the image.
      // Leave vertical_text null if the model couldn't read it.

      // 15. Derive vertical_text_type from the finalized vertical_text value
      const PLATE_SUFFIX_MARKERS = new Set(['DP','DV','DPE','DVE']);
      if (data.vertical_text) {
        const vtUp = data.vertical_text.toUpperCase().trim();
        if (PLATE_SUFFIX_MARKERS.has(vtUp)) {
          data.vertical_text_type = 'plate_suffix';
        } else if (!data.vertical_text_type || !['plate_suffix','state_name','decorative'].includes(data.vertical_text_type)) {
          data.vertical_text_type = 'decorative';
        }
      } else {
        data.vertical_text_type = null;
      }

      // 16. Derive disabled_type from vertical_text suffix (does NOT override design_type).
      // design_type stays as the base plate design (e.g. "Standard Passenger Vehicle").
      // disabled_type is a separate classification driven entirely by the suffix read.
      const SUFFIX_TO_DISABLED_TYPE = { 'DP': 'Disabled Person', 'DV': 'Disabled Veteran', 'DPE': 'Disabled Person (Exempt)', 'DVE': 'Disabled Veteran (Exempt)' };
      if (data.is_disabled) {
        const vtKey = data.vertical_text ? data.vertical_text.toUpperCase().trim() : null;
        data.disabled_type = vtKey && SUFFIX_TO_DISABLED_TYPE[vtKey] ? SUFFIX_TO_DISABLED_TYPE[vtKey] : 'Unknown — suffix not readable';
      } else {
        data.disabled_type = null;
      }

      // 16b. variant_hint → design_type promotion: if variant_hint matches a valid taxonomy entry
      // but design_type is generic (e.g. "Standard Passenger Vehicle"), promote the hint.
      if (data.design?.variant_hint && data.state) {
        const hint = data.design.variant_hint;
        const STATE_ABBR2 = { 'California':'CA','Arizona':'AZ','Texas':'TX','Florida':'FL','New York':'NY','Washington':'WA' };
        const stKey = plateTypeTaxonomy[data.state] ? data.state
          : plateTypeTaxonomy[STATE_ABBR2[data.state]] ? STATE_ABBR2[data.state] : null;
        if (stKey && plateTypeTaxonomy[stKey]) {
          // Build flat set of all valid design_type names for this state
          const allTypes = new Set(Object.values(plateTypeTaxonomy[stKey]).flat().map(t => t.toLowerCase()));
          const hintLower = hint.toLowerCase();
          const dtLower = (data.design_type || '').toLowerCase();
          const genericTypes = new Set(['standard passenger vehicle', 'standard', 'passenger', 'standard plate']);
          // If current design_type is generic but variant_hint IS a valid taxonomy entry, promote it
          if (genericTypes.has(dtLower) && allTypes.has(hintLower)) {
            // Find the exact-cased version from taxonomy
            const exactMatch = Object.values(plateTypeTaxonomy[stKey]).flat().find(t => t.toLowerCase() === hintLower);
            if (exactMatch) data.design_type = exactMatch;
          }
        }
      }

      // 16c. Sanitize design_type — strip bracket-wrapped category headers the model sometimes returns.
      // e.g. "[Standard Plates]" → null (let the UI show "—" rather than an internal label)
      if (typeof data.design_type === 'string') {
        const dt = data.design_type.trim();
        if (/^\[.*\]$/.test(dt)) {
          // Entire value is a bracketed header — not a valid leaf type
          data.design_type = null;
        } else {
          // Strip any trailing bracket annotation e.g. "Standard Passenger Vehicle [Standard Plates]"
          data.design_type = dt.replace(/\s*\[.*?\]\s*$/g, '').trim() || null;
        }
      }

      // 17. Derive registration_current from expiration_month + expiration_year vs today
      // Registration is valid through the last day of the expiration month.
      // If only year is known: Yes if year > current year, No if year < current year, Unknown if same year.
      // If neither is known: Unknown.
      (function() {
        const now = new Date();
        const yr = data.expiration_year;
        const mo = data.expiration_month; // 1-indexed

        if (!yr) {
          data.registration_current = 'Unknown';
          return;
        }
        if (!mo) {
          if (yr > now.getFullYear())      data.registration_current = 'Yes';
          else if (yr < now.getFullYear()) data.registration_current = 'No';
          else                             data.registration_current = 'Unknown'; // same year, no month
          return;
        }
        // Expiration: valid through end of expiration month
        // Last day of month = first day of following month - 1ms
        const expiryEnd = new Date(yr, mo, 1); // month is 0-indexed in Date, so mo (1-indexed) = next month
        data.registration_current = now < expiryEnd ? 'Yes' : 'No';
      })();

      return data;
    }


    // value: the actual extracted value — badge suppressed when value is null/absent
    