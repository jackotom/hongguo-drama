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

// Token-level JSON parser to detect duplicate keys in single-line, multi-line, or array-nested objects.
function checkDuplicateJsonKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  JSON.parse(text);
  const rel = path.relative(root, file);
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };
  const readString = () => {
    const start = i++;
    let out = '';
    while (i < n) {
      const ch = text[i++];
      if (ch === '\\') { out += ch + (text[i++] || ''); continue; }
      if (ch === '"') return JSON.parse(text.slice(start, i));
      out += ch;
    }
    return '';
  };
  const parseValue = () => {
    skipWs();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const keys = new Set();
      skipWs();
      if (text[i] === '}') { i++; return; }
      while (i < n) {
        skipWs();
        const keyPos = i;
        const key = readString();
        if (keys.has(key)) {
          const line = text.slice(0, keyPos).split('\n').length;
          errors.push(`${rel}:${line} 重复 JSON 键 "${key}"`);
        }
        keys.add(key);
        skipWs();
        if (text[i] === ':') i++;
        parseValue();
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        break;
      }
      return;
    }
    if (ch === '[') {
      i++;
      skipWs();
      if (text[i] === ']') { i++; return; }
      while (i < n) {
        parseValue();
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        break;
      }
      return;
    }
    if (ch === '"') { readString(); return; }
    while (i < n && !/[\s,\]\}]/.test(text[i])) i++;
  };
  parseValue();
}

function stripCommentsAndStrings(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
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
  const loader = file.endsWith('.jsx') ? 'jsx' : 'js';
  try {
    const transformed = esbuild.transformSync(source, { loader, sourcefile: rel });
    if (/\bdebugger\b/.test(stripCommentsAndStrings(transformed.code))) {
      errors.push(`${rel}: 存在残留 debugger 语句`);
    }
  } catch (err) {
    errors.push(`${rel}: 语法错误 - ${err.message}`);
  }
}

const jsonFiles = [
  path.join(root, 'package.json'),
  ...walk(path.join(root, 'src/i18n'), ['.json']),
].filter(file => fs.existsSync(file));

for (const jsonFile of jsonFiles) {
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
console.log(`check-code-hygiene: ${codeFiles.length} source files + ${jsonFiles.length} JSON files passed`);
