const fs=require("fs");
const js=fs.readFileSync("out/ollama-chat.js","utf8");
const idx=js.indexOf("waIncoming");
if(idx<0){console.log("not found");process.exit();}
// Show all occurrences
let pos=0;
while(true){
  const i=js.indexOf("waIncoming",pos);
  if(i<0)break;
  const ln=js.substring(0,i).split("\n").length;
  console.log("at JS line",ln,"offset",i);
  console.log("context:",JSON.stringify(js.substring(i-20,i+120)));
  pos=i+1;
}
