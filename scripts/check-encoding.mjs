import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const TARGET_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.html', '.css', '.svg', '.xml', '.yml', '.yaml', '.cjs', '.mjs', '.txt'
]);

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', '.next', 'build']);

const badFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      if (IGNORE_DIRS.has(entry.name)) continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name === 'check-encoding.mjs') continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!TARGET_EXTS.has(ext)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes('�')) {
      const count = [...content].filter((ch) => ch === '�').length;
      badFiles.push({ file: path.relative(ROOT, fullPath), count });
    }
  }
}

walk(ROOT);

if (badFiles.length === 0) {
  console.log('No replacement characters detected (�).');
  process.exit(0);
}

console.error('Potential encoding corruption found:');
for (const { file, count } of badFiles) {
  console.error(`- ${file} (${count} issue)`);
}
process.exit(1);
