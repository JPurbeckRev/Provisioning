const fs = require('fs');
let code = fs.readFileSync('web-projects/Platez/Provisioner/js/platez-engine.js', 'utf8');

// The goal is to make a clean `export async function extractPlateData(imageBase64, lmStudioUrl)`
// We will wrap the inner logic of `analyze()` into this function.
// Since `analyze()` has hardcoded DOM references, we replace them.

code = code.replace(/analyzeBtn\.disabled = [^;]+;/g, '');
code = code.replace(/analyzeBtn\.innerHTML = [^;]+;/g, '');
code = code.replace(/cancelBtn\.style\.display = [^;]+;/g, '');
code = code.replace(/clearError\(\);/g, '');
code = code.replace(/document\.getElementById\([^)]+\)\.style\.display = [^;]+;/g, '');
code = code.replace(/document\.getElementById\([^)]+\)\.classList\.remove\([^)]+\);/g, '');
code = code.replace(/results\.style\.display = [^;]+;/g, '');
code = code.replace(/statusMsg\.innerHTML = [^;]+;/g, '');
code = code.replace(/statusMsg\.style\.display = [^;]+;/g, '');
code = code.replace(/document\.querySelectorAll\([^)]+\)\.forEach\([^)]+\);/g, '');
code = code.replace(/activeAbort = new AbortController\(\);/g, 'const activeAbort = new AbortController();');
code = code.replace(/const timeoutId = setTimeout\(\(\) => activeAbort\?\.abort\(\), 90000\);/g, 'const timeoutId = setTimeout(() => activeAbort?.abort(), 90000);');

// The `apiBase` and `modelId`
code = code.replace(/const apiBase = [^;]+;/g, 'const apiBase = lmStudioUrl;');
code = code.replace(/const modelId = modelSelect\.value \|\| 'qwen\/qwen3\.6-35b-a3b';/g, "const modelId = 'qwen/qwen2.5-vl-7b';"); // We'll use the vision model

// Replace the start of analyze
code = code.replace(/async function analyze\(\) \{[\s\S]*?(?=\/\/ PLZ-04:)/, 'async function extractPlateData(imageBase64, lmStudioUrl, plateTypeTaxonomy) {\n');

// Replace the end of analyze (where it renders results)
const renderCall = /renderResults\(data, rawStr\);/;
const endIndex = code.search(renderCall);
if (endIndex > -1) {
  // slice off the end and just return data
  const beforeRender = code.slice(0, endIndex);
  code = beforeRender + 'return data;\n    } catch(err) { throw err; }\n  } // end extractPlateData\n';
}

fs.writeFileSync('web-projects/Platez/Provisioner/js/platez-engine.js', code);
console.log("Cleaned!");
