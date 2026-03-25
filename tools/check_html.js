const fs = require("fs");
const src = fs.readFileSync("out/ollama-chat.js", "utf8");
// Find the getHtmlForWebview section and extract line 144 of the HTML
const startMarker = "<!doctype html>";
const idx = src.indexOf(startMarker);
if (idx < 0) { console.log("Not found"); process.exit(1); }
// count newlines from idx to find line 144
let lineCount = 1;
let pos = idx;
while (lineCount < 144 && pos < src.length) {
  if (src[pos] === "\n") lineCount++;
  pos++;
}
const lineStart = pos;
const lineEnd = src.indexOf("\n", lineStart);
const line = src.substring(lineStart, lineEnd > 0 ? lineEnd : lineStart + 200);
console.log("Line 144:", line.substring(0, 150));
console.log("Col 81:", JSON.stringify(line.substring(78, 90)));
