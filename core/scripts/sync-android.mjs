// Copies the built web core into the Android app's assets (app/src/main/assets/web).
import { cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dst = resolve(root, '../app/src/main/assets/web');
rmSync(dst, { recursive: true, force: true });
cpSync(resolve(root, 'dist'), dst, { recursive: true });
console.log(`synced dist -> ${dst}`);
