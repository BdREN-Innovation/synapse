const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'packages/api/src/prompts/default.ts');
const compiled = path.join(root, 'packages/api/dist/index.cjs');

if (!fs.existsSync(compiled)) {
  console.error(`Missing ${path.relative(root, compiled)}. Run npm run build:api first.`);
  process.exit(1);
}

if (fs.statSync(compiled).mtimeMs < fs.statSync(source).mtimeMs) {
  console.error(
    `${path.relative(root, compiled)} is older than ${path.relative(root, source)}. Run npm run build:api or use the watch workflow.`,
  );
  process.exit(1);
}

console.log('packages/api/dist is current for the prompt source.');
