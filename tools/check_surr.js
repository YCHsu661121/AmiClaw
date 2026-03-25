const fs=require("fs");
const js=fs.readFileSync("out/ollama-chat.js","utf8");
// Check if the compiled JS has \uD83D in a template literal context
const idx=js.indexOf("\\uD83D");
if(idx<0){console.log("NOT FOUND \\\\uD83D in compiled JS");process.exit();}
console.log("Found at offset",idx);
console.log("Context:",JSON.stringify(js.substring(idx-50,idx+60)));
// Count lines to this position
const before=js.substring(0,idx);
const lineNum=before.split("\n").length;
console.log("At compiled JS line:",lineNum);
