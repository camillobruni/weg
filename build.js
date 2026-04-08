import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'fs/promises';
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
};

async function collectLicenses() {
  const deps = ['leaflet', 'uplot', 'fit-file-parser'];
  let output = '';

  // 1. Root License
  try {
    const rootLicense = await readFile('LICENSE', 'utf-8');
    output += 'WEG LICENSE\n';
    output += '===========\n\n';
    output += rootLicense + '\n\n';
  } catch (e) {}

  // 2. Dependency Licenses
  for (const dep of deps) {
    try {
      const licensePath = path.join('node_modules', dep, 'LICENSE');
      const content = await readFile(licensePath, 'utf-8');
      output += `\n\n------------------------------------------------------------------------------\n`;
      output += `${dep.toUpperCase()} LICENSE\n`;
      output += `------------------------------------------------------------------------------\n\n`;
      output += content + '\n';
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
  // We mark dependencies as external so they are not included in the main bundle
  const ctxWeg = await esbuild.context({
    ...baseConfig,
    entryPoints: ['src/app.ts'],
    entryNames: 'weg',
    external: ['leaflet', 'uplot', 'fit-file-parser'],
  });

  // 2. Bundle Vendors individually
  const vendorEntryPoints = {
    'leaflet': 'node_modules/leaflet/dist/leaflet-src.js',
    'uplot': 'node_modules/uplot/dist/uPlot.esm.js',
    'fit-file-parser': 'src/vendor-fit.ts', // Wrapper to expose ESM
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
    external: ['*.png', '*.gif'],
  });

  if (watch) {
    await Promise.all([
      ctxWeg.watch(),
      ctxCss.watch(),
      ...vendorCtxs.map(c => c.watch())
    ]);
    console.log('Watching for changes...');

    // Simple dev server
    const { host, port } = await ctxWeg.serve({
      servedir: '.',
      fallback: 'index.html',
    });
    console.log(`Server running at http://${host}:${port}`);
  } else {
    await Promise.all([
      ctxWeg.rebuild(),
      ctxCss.rebuild(),
      ...vendorCtxs.map(c => c.rebuild())
    ]);
    await collectLicenses();
    await Promise.all([
      ctxWeg.dispose(),
      ctxCss.dispose(),
      ...vendorCtxs.map(c => c.dispose())
    ]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
