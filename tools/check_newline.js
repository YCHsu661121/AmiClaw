const fs=require('fs');
const js=fs.readFileSync('out/ollama-chat.js','utf8');
const dIdx=js.indexOf('<!doctype html>');
const htmlStr=js.substring(dIdx,dIdx+500000);
const waIdx=htmlStr.indexOf('waIncoming');
const waCtx=htmlStr.substring(waIdx,waIdx+300);
console.log('waIncoming context:',JSON.stringify(waCtx.substring(0,250)));
// check for naked \n inside single-quoted string within 50 chars of waIncoming content
const appendIdx=htmlStr.indexOf("appendMessage",waIdx);
const appendCtx=htmlStr.substring(appendIdx,appendIdx+200);
const hasNakedNewline=/'\[^\n']*\n[^\n']*'/.test(appendCtx);
console.log('Has naked newline in appendMessage string:', hasNakedNewline);
console.log('appendMessage ctx:', JSON.stringify(appendCtx));
