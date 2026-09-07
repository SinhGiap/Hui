'use strict';
// Builds the two deployment bundles.
//
// Windows makes this fiddlier than it should be. PowerShell 5.1's
// Compress-Archive writes backslash path separators, which Linux cannot extract -
// Beanstalk rejects the bundle with "source bundle has issues". Windows' own
// bsdtar writes correct separators, but bare `tar` resolves to GNU tar under Git
// Bash (which npm uses for scripts) and GNU tar cannot write zip at all - it
// silently emits a plain tar with a .zip name. So: absolute path, and
// execFileSync with no shell, which behaves the same however this is invoked.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

// Each tier ships only what it loads: the API never requires express or ejs, the
// web tier never requires an AWS SDK, and the deploy-only SDKs belong in neither.
const BUILD_ONLY = ['client-api-gateway', 'client-cloudfront', 'client-elastic-beanstalk',
  'client-eventbridge', 'client-lambda'].map((p) => `node_modules/@aws-sdk/${p}`);

const BUNDLES = {
  api: {
    out: 'dist-api.zip',
    items: ['api', 'node_modules', 'package.json'],
    omit: [...BUILD_ONLY, 'node_modules/express', 'node_modules/ejs'],
  },
  web: {
    out: 'dist-web.zip',
    items: ['web', 'node_modules', 'package.json', 'Procfile'],
    omit: ['node_modules/@aws-sdk', 'node_modules/@smithy'],
  },
};

function build(which) {
  const bundle = BUNDLES[which];
  if (!bundle) throw new Error(`unknown bundle "${which}" (expected: ${Object.keys(BUNDLES).join(', ')})`);
  const { out, items, omit } = bundle;
  fs.rmSync(out, { force: true });
  const excludes = omit.flatMap((o) => [`--exclude=${o}`, `--exclude=${o}/*`]);
  execFileSync(TAR, ['-a', '-c', '-f', out, ...excludes, ...items], { stdio: 'pipe' });
  const mb = fs.statSync(out).size / 1048576;
  // A plain tar would be ~4x this. Catching it here beats a "could not unzip"
  // three minutes later from Lambda.
  if (mb > 25) throw new Error(`${out} is ${mb.toFixed(1)} MB - not compressed, so ${TAR} did not produce a zip`);
  return { file: out, mb };
}

module.exports = { build };

if (require.main === module) {
  const { file, mb } = build(process.argv[2]);
  console.log(`${file} ${mb.toFixed(1)} MB`);
}
