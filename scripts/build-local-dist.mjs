import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const cssPath = path.join(rootDir, 'src', 'styles.css');
const entryPath = path.join(rootDir, 'src', 'main.build.tsx');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const css = await readFile(cssPath, 'utf8');
const jsResult = await build({
  absWorkingDir: rootDir,
  entryPoints: [entryPath],
  bundle: true,
  format: 'iife',
  globalName: 'ScratchMyTableApp',
  jsx: 'automatic',
  jsxImportSource: 'react',
  minify: true,
  write: false,
  platform: 'browser',
  target: ['es2020'],
});

const js = jsResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Scratch My Table</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
${js}
    </script>
  </body>
</html>
`;

await writeFile(path.join(distDir, 'index.html'), html, 'utf8');
