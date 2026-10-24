const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { signAsync } = require('@electron/osx-sign');
module.exports = async function signBeta(context) {
 if (context.electronPlatformName !== 'darwin') return;
 const app = path.join(context.appOutDir, 'Openwhispr.app');
 const entitlements = path.join(context.packager.projectDir, 'build/entitlements.beta.plist');
 const helpers = ['macos-asr-helper/openwhispr-asr-helper','macos-system-audio-helper/openwhispr-system-audio-helper','macos-coreaudio-tap-helper/openwhispr-coreaudio-tap-helper'].map(item => {
  const [dir, name] = item.split('/');
  return path.join(app, 'Contents/Resources/app-assets/tools', dir, '.build/release', name);
 });
 await signAsync({ app, identity: '-', identityValidation: false, platform: 'darwin',
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  binaries: helpers,
  // Sign Mach-O code, not binary model weights, compressed lexicons or icon images.
  ignore: (file) => {
    if (fs.statSync(file).isDirectory()) return false;
    const fd = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    return !['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex'));
  },
  optionsForFile: () => ({ entitlements, hardenedRuntime: true, timestamp: 'none' })
 });
 execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
 const info = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(app,'Contents/Info.plist')], { encoding:'utf8' }).trim();
 if (!fs.existsSync(path.join(app,'Contents/Resources',info.endsWith('.icns') ? info : info+'.icns'))) throw new Error('Packaged app icon is missing');
 console.log('Beta signature and app icon verified. Ad-hoc signing does not provide Apple notarization.');
};
