const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function loadFixture(mutate) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8'));
  if (mutate) mutate(dom.window.document);
  return dom.window.document;
}
module.exports = { loadFixture };
