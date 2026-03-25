const fs=require("fs");
const js=fs.readFileSync("out/ollama-chat.js","utf8");
const idx=js.indexOf("return `<!doctype html>");
const ctx=js.substring(idx,idx+200);
console.log("return uses template literal:", idx>=0);
console.log("context:", JSON.stringify(ctx.substring(0,100)));
// check if waIncoming surrogate is still a template literal escape
const s1=js.indexOf("uD83D\\\\uDCF2");
const s2=js.indexOf("\\\\uD83D\\\\uDCF2");
console.log("uD83D\\\\uDCF2 idx:", s1, "\\\\\\\\uD83D idx:", s2);
