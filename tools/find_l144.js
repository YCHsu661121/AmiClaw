const fs=require("fs");
const compiled=fs.readFileSync("out/ollama-chat.js","utf8");
// get HTML string: find <!doctype and then count to line 144
const dIdx=compiled.indexOf("<!doctype html>");
if(dIdx<0){console.log("not found");process.exit();}
// Now walk through the template to find line 144 
// TypeScript compiles template literals - find the actual newlines
let ln=1,pos=dIdx;
while(ln<144&&pos<compiled.length){if(compiled[pos]==="\n")ln++;pos++;}
const ls=pos;
const le=compiled.indexOf("\n",ls);
const line=compiled.substring(ls,le>0?le:ls+300);
console.log("HTML L144 content (first 160):",JSON.stringify(line.substring(0,160)));
// col 81 = index 80 in line
console.log("Around col 81:",JSON.stringify(line.substring(77,87)));
