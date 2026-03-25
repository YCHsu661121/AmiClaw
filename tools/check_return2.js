const fs=require("fs");
const js=fs.readFileSync("out/ollama-chat.js","utf8");
const idx=js.indexOf("getHtmlForWebview(_webview)");
const ctx=js.substring(idx,idx+300);
console.log("method def context:", JSON.stringify(ctx));
