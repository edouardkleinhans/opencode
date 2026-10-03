// Add focused cases to the pinned upstream store's existing test harness.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const target = path.join(root, 'packages/ui/src/stores/useConfigStore.test.ts');
const marker = "  test('provider and agent discovery gaps preserve a manual model and effort', async () => {";
const source = fs.readFileSync(target, 'utf8');
if (source.split(marker).length !== 2 || source.includes('HA new chat remembers')) throw new Error('Unexpected preview model test harness');
fs.writeFileSync(target, source.replace(marker, fs.readFileSync(path.join(__dirname, 'openchamber-model-regressions.inc.ts'), 'utf8') + marker));
