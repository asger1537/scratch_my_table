import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const aiLogFilePath = path.resolve(repoRoot, '.logs', 'ai-debug.log');

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'ai-dev-log',
      configureServer(server) {
        server.middlewares.use('/__ai-log', async (request, response, next) => {
          if (request.method !== 'POST') {
            next();
            return;
          }

          try {
            const body = await readRequestBody(request);
            const payload = body.trim() === '' ? {} : JSON.parse(body);

            await mkdir(path.dirname(aiLogFilePath), { recursive: true });
            await appendFile(
              aiLogFilePath,
              `${JSON.stringify({
                loggedAt: new Date().toISOString(),
                ...payload,
              })}\n`,
              'utf8',
            );

            response.statusCode = 204;
            response.end();
          } catch (error) {
            response.statusCode = 500;
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Failed to write AI dev log.',
              }),
            );
          }
        });
      },
    },
  ],
});

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}
