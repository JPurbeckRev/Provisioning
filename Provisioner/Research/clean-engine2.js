const fs = require('fs');
let code = fs.readFileSync('web-projects/Platez/Provisioner/js/platez-engine.js', 'utf8');

const renderCall = /renderResults\(data, JSON\.stringify\(data, null, 2\)\);/;
const endIndex = code.search(renderCall);
if (endIndex > -1) {
  const beforeRender = code.slice(0, endIndex);
  code = beforeRender + 'return data;\n    } catch(err) { throw err; }\n  } // end extractPlateData\n\n' + code.slice(endIndex + 100);
}

fs.writeFileSync('web-projects/Platez/Provisioner/js/platez-engine.js', code);
console.log("Cleaned 2!");
