import { readFileSync, writeFileSync } from 'node:fs';

const destination = new URL('../electron.d.ts', import.meta.url);
const source = new URL('../typings/agent-automation.d.ts', import.meta.url);
const content = readFileSync(destination, 'utf8');
const marker = content.search(
  /declare namespace Electron \{\r?\n {2}interface MouseEvent \{\r?\n {4}target\?: AgentTarget;/
);
writeFileSync(
  destination,
  (marker < 0 ? content : content.slice(0, marker)).trimEnd() + '\n' + readFileSync(source, 'utf8')
);
