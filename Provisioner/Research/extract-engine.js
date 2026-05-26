const fs = require('fs');
const html = fs.readFileSync('web-projects/Platez/index.html', 'utf8');

const cropStart = html.indexOf('function cropCorner');
const renderStart = html.indexOf('function getConfBadgeHtml');

if (cropStart > -1 && renderStart > -1) {
  let code = html.slice(cropStart, renderStart);
  fs.mkdirSync('web-projects/Platez/Provisioner/js', {recursive:true});
  fs.writeFileSync('web-projects/Platez/Provisioner/js/platez-engine.js', code);
  console.log("Extracted engine!");
} else {
  console.log("Not found.");
}
