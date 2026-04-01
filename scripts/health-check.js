#!/usr/bin/env node
/**
 * 代码健康度检查脚本 (Node.js)
 *
 * 汇总项目各维度指标，输出健康度报告：
 * - 代码规模（文件数、代码行数）
 * - TypeScript 编译错误（tsc --noEmit）
 * - 冗余代码（knip）
 * - 构建状态
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIVIDER = "─".repeat(60);

/** @type {{ label: string; value: string | number; status: 'ok'|'warn'|'error'|'info' }[]} */
const metrics = [];

function add(label, value, status = "info") {
  metrics.push({ label, value, status });
}

function icon(status) {
  switch (status) {
    case "ok":    return "[OK]";
    case "warn":  return "[!!]";
    case "error": return "[XX]";
    case "info":  return "[--]";
  }
}

function exec(cmd) {
  try {
    return { stdout: execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    return { stdout: (e.stdout || "") + (e.stderr || ""), code: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// 1. 代码规模
// ---------------------------------------------------------------------------
function checkCodeSize() {
  const srcDir = path.join(__dirname, "..", "src");
  let fileCount = 0;
  let totalLines = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        fileCount++;
        const content = fs.readFileSync(fullPath, "utf8");
        totalLines += content.split("\n").length;
      }
    }
  }

  walk(srcDir);
  add("TypeScript 文件数", fileCount, "info");
  add("总代码行数 (src/)", totalLines, "info");
}

// ---------------------------------------------------------------------------
// 2. TypeScript 编译检查
// ---------------------------------------------------------------------------
function checkTypeScript() {
  const tsc = path.join(__dirname, "..", "node_modules", ".bin", "tsc");
  const result = exec(`"${tsc}" --noEmit -p tsconfig.json`);
  const errorLines = result.stdout.split("\n").filter(l => /error TS/.test(l));
  const errorCount = errorLines.length;
  add("TS 编译错误", errorCount, errorCount === 0 ? "ok" : errorCount < 10 ? "warn" : "error");
}

// ---------------------------------------------------------------------------
// 3. 冗余代码（knip）
// ---------------------------------------------------------------------------
function checkUnused() {
  const knip = path.join(__dirname, "..", "node_modules", ".bin", "knip");
  if (!fs.existsSync(knip)) {
    add("冗余代码检查", "knip 未安装 (npm install)", "warn");
    return;
  }
  const result = exec(`"${knip}" --reporter compact`);
  const unusedFiles   = result.stdout.match(/Unused files \((\d+)\)/);
  const unusedExports = result.stdout.match(/Unused exports \((\d+)\)/);
  const unusedDeps    = result.stdout.match(/Unused dependencies \((\d+)\)/);
  add("未使用文件",   unusedFiles?.[1]   ?? "0", "info");
  add("未使用导出",   unusedExports?.[1] ?? "0", "info");
  add("未使用依赖",   unusedDeps?.[1]    ?? "0",
    unusedDeps && Number(unusedDeps[1]) > 0 ? "warn" : "ok");
}

// ---------------------------------------------------------------------------
// 4. 构建状态
// ---------------------------------------------------------------------------
function checkBuild() {
  const tsc = path.join(__dirname, "..", "node_modules", ".bin", "tsc");
  const result = exec(`"${tsc}" -p tsconfig.json`);
  if (result.code === 0) {
    const outFile = path.join(__dirname, "..", "out", "extension.js");
    if (fs.existsSync(outFile)) {
      const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
      add("构建状态", "成功", "ok");
      add("产物大小 (out/extension.js)", `${kb} KB`, "info");
    } else {
      add("构建状态", "成功 (无产物)", "warn");
    }
  } else {
    add("构建状态", "失败", "error");
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log("");
console.log(DIVIDER);
console.log("  代码健康度检查报告 — ami-ai-claw");
console.log(`  ${new Date().toLocaleString("zh-TW")}`);
console.log(DIVIDER);

checkCodeSize();
checkTypeScript();
checkUnused();
checkBuild();

console.log("");
for (const m of metrics) {
  const tag = icon(m.status);
  console.log(`  ${tag}  ${String(m.label).padEnd(28)} ${m.value}`);
}

const errorCount = metrics.filter(m => m.status === "error").length;
const warnCount  = metrics.filter(m => m.status === "warn").length;

console.log("");
console.log(DIVIDER);
if (errorCount > 0) {
  console.log(`  结果: ${errorCount} 个错误, ${warnCount} 个警告`);
} else if (warnCount > 0) {
  console.log(`  结果: 无错误, ${warnCount} 个警告`);
} else {
  console.log("  结果: 全部通过");
}
console.log(DIVIDER);
console.log("");

process.exit(errorCount > 0 ? 1 : 0);
