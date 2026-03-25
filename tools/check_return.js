const fs=require("fs");
const js=fs.readFileSync("out/ollama-chat.js","utf8");
// Find getHtmlForWebview compiled output
const idx=js.indexOf("getHtmlForWebview");
if(idx<0){console.log("not found");process.exit();}
// look at the return statement nearby
const ctx=js.substring(idx,idx+600);
console.log(JSON.stringify(ctx.substring(0,600)));
