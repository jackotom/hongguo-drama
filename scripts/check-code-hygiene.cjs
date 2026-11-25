// Lightweight static hygiene check (syntax, duplicate JSON keys, conflict markers, debugger statements).
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const errors = [];

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some(ext => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function checkDuplicateJsonKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  JSON.parse(text);
  // Check top-level and nested object duplicate keys via line-level key scan within brace depth.
  const stack = [new Set()];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.endsWith('{')) {
      const m = line.match(/^"((?:\\.|[^"\\])*)"\s*:/);
      if (m) {
        const current = stack[stack.length - 1];
        if (current.has(m[1])) errors.push(`${path.relative(root, file)}:${i + 1} 重复 JSON 键 "${m[1]}"`);
        current.add(m[1]);
      }
      stack.push(new Set());
      continue;
    }
    if (line.startsWith('}')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const m = line.match(/^"((?:\\.|[^"\\])*)"\s*:/);
    if (m) {
      const current = stack[stack.length - 1];
      if (current.has(m[1])) errors.push(`${path.relative(root, file)}:${i + 1} 重复 JSON 键 "${m[1]}"`);
      current.add(m[1]);
    }
  }
}

const codeFiles = [
  path.join(root, 'main.js'),
  path.join(root, 'preload.js'),
  path.join(root, 'vite.config.js'),
  ...walk(path.join(root, 'src'), ['.js', '.jsx', '.cjs', '.mjs']),
  ...walk(path.join(root, 'server'), ['.js', '.cjs', '.mjs']),
].filter(file => fs.existsSync(file) && !file.endsWith('.test.cjs') && !file.endsWith('.test.mjs'));

for (const file of codeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) {
    errors.push(`${rel}: 存在未解决的 Git 冲突标记`);
  }
  if (/\bdebugger\b/.test(source)) {
    errors.push(`${rel}: 存在残留 debugger 语句`);
  }
  const loader = file.endsWith('.jsx') ? 'jsx' : 'js';
  try {
    esbuild.transformSync(source, { loader, sourcefile: rel });
  } catch (err) {
    errors.push(`${rel}: 语法错误 - ${err.message}`);
  }
}

for (const jsonFile of walk(path.join(root, 'src/i18n'), ['.json'])) {
  try {
    checkDuplicateJsonKeys(jsonFile);
  } catch (err) {
    errors.push(`${path.relative(root, jsonFile)}: JSON 校验失败 - ${err.message}`);
  }
}

if (errors.length) {
  console.error('Code hygiene check failed:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log(`check-code-hygiene: ${codeFiles.length} source files + i18n JSON passed`);
