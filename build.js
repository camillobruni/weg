// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'; // Added copyFile
import path from 'path';

const args = process.argv.slice(2);
const watch = args.includes('--watch');

const baseConfig = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: 'esm',
  target: ['es2020'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  loader: {
    '.woff2': 'file',
    '.png': 'file',
    '.svg': 'file',
  },
  alias: {
    // When leaflet.css asks for 'images/layers.png', look here:
    'images': path.resolve('node_modules/leaflet/dist/images'),
  },
};

/**
 * Copies static assets that esbuild doesn't handle via imports.
 * For index.html, it also removes the 'dist/' prefix from all paths.
 */
async function copyStaticAssets() {
  const assets = ['index.html', 'material_icons.woff2', 'material_symbols_rounded.woff2'];
  await mkdir('dist', { recursive: true });

  for (const asset of assets) {
    try {
      if (asset === 'index.html') {
        let content = await readFile(asset, 'utf-8');
        content = content.replace(/dist\//g, '');
        await writeFile(path.join('dist', asset), content);
        console.log(`Converted and copied ${asset} to dist/`);
      } else {
        await copyFile(asset, path.join('dist', asset));
        console.log(`Copied ${asset} to dist/`);
      }
    } catch (e) {
      console.warn(`Could not copy ${asset}: ${e.message}`);
    }
  }
}

async function collectLicenses() {
  const deps = ['leaflet', 'uplot', 'fit-file-parser'];
  let output = '';

  try {
    const rootLicense = await readFile('LICENSE', 'utf-8');
    output += 'WEG LICENSE\n===========\n\n' + rootLicense + '\n\n';
  } catch (e) {}

  for (const dep of deps) {
    try {
      const licensePath = path.join('node_modules', dep, 'LICENSE');
      const content = await readFile(licensePath, 'utf-8');
      output += `\n\n------------------------------------------------------------------------------\n${dep.toUpperCase()} LICENSE\n------------------------------------------------------------------------------\n\n${content}\n`;
    } catch (e) {
      console.warn(`Could not find license for ${dep}`);
    }
  }

  await mkdir('dist', { recursive: true });
  await writeFile(path.join('dist', 'LICENSE'), output);
  console.log('Generated dist/LICENSE');
}

async function build() {
  // 1. Bundle Weg code
  const ctxWeg = await esbuild.context({
    ...baseConfig,
    entryPoints: ['src/app.ts'],
    entryNames: 'weg',
    external: ['leaflet', 'uplot', 'fit-file-parser'],
  });

  // 2. Bundle Vendors
  const vendorEntryPoints = {
    'leaflet': 'node_modules/leaflet/dist/leaflet-src.js',
    'uplot': 'node_modules/uplot/dist/uPlot.esm.js',
    'fit-file-parser': 'src/vendor-fit.ts', 
  };

  const vendorCtxs = await Promise.all(
    Object.entries(vendorEntryPoints).map(([name, entry]) =>
      esbuild.context({
        ...baseConfig,
        entryPoints: [entry],
        entryNames: name,
      })
    )
  );

  // 3. Bundle CSS
  const ctxCss = await esbuild.context({
    ...baseConfig,
    entryPoints: ['src/css/styles.css'],
    entryNames: 'styles',
    // We don't mark these external if we want them in dist/
    // loader will handle them
  });

  if (watch) {
    await Promise.all([
      ctxWeg.watch(),
      ctxCss.watch(),
      ...vendorCtxs.map(c => c.watch())
    ]);
    
    // In watch mode, we serve from the project root so index.html works
    const { host, port } = await ctxWeg.serve({
      servedir: '.', 
      fallback: 'index.html',
    });
    console.log(`Development server: http://${host}:${port}`);
  } else {
    // Production Build
    await Promise.all([
      ctxWeg.rebuild(),
      ctxCss.rebuild(),
      ...vendorCtxs.map(c => c.rebuild())
    ]);
    
    await copyStaticAssets(); // Crucial for production
    await collectLicenses();
    
    await Promise.all([
      ctxWeg.dispose(),
      ctxCss.dispose(),
      ...vendorCtxs.map(c => c.dispose())
    ]);
    console.log('Build complete. Production files are in dist/');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});