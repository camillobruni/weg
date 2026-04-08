import * as esbuild from 'esbuild';
import { copyFile } from 'fs/promises';

const args = process.argv.slice(2);
const watch = args.includes('--watch');

const baseConfig = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: 'esm',
  target: ['es2020'],
  outdir: 'dist',
};

async function build() {
  // 1. Bundle Weg code
  // We mark dependencies as external so they are not included in the main bundle
  const ctxWeg = await esbuild.context({
    ...baseConfig,
    entryPoints: ['src/app.ts'],
    entryNames: 'weg',
    external: ['leaflet', 'uplot', 'fit-file-parser'],
  });

  // 2. Bundle Vendors
  const ctxVendor = await esbuild.context({
    ...baseConfig,
    entryPoints: ['src/vendor.ts'],
    entryNames: 'vendor',
  });

  if (watch) {
    await Promise.all([ctxWeg.watch(), ctxVendor.watch()]);
    console.log('Watching for changes...');

    // Simple dev server
    const { host, port } = await ctxWeg.serve({
      servedir: '.',
      fallback: 'index.html',
    });
    console.log(`Server running at http://${host}:${port}`);
  } else {
    await Promise.all([ctxWeg.rebuild(), ctxVendor.rebuild()]);
    await Promise.all([ctxWeg.dispose(), ctxVendor.dispose()]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
