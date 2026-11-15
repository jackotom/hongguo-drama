// Offline Windows AMF build contract check. Reads build scripts and workflow; no network or compile.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const failures = [];
function contract(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures.push(name); console.error('FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const ffwin = read('scripts/build-ffmpeg-source-win.sh');
const librempeg = read('scripts/build-librempeg-source.sh');
const fflinux = read('scripts/build-ffmpeg-source-linux.sh');
const workflow = read('.github/workflows/windows.yml');
const linuxWorkflow = read('.github/workflows/linux.yml');
const amfPrepPath = path.join(root, 'scripts/prepare-amf-headers.sh');
const amfPrep = fs.existsSync(amfPrepPath) ? fs.readFileSync(amfPrepPath, 'utf8') : '';
const windowsRelease = read('scripts/check-windows-release.cjs');
const ffmpegNotice = read('build/ffmpeg/WINDOWS-NOTICE.txt');
const librempegNotice = read('build/ffmpeg/LIBREMPEG-NOTICE.txt');

const COMMIT = '57ee0cfb0e1a08d9041f77435653794c1b012be0';
const HEADERS_SHA = '0f521ad98041f8001147cded4a660127f18b1c27a801a5cd691bda1fa48381be';
const LICENSE_SHA = 'eb297397aaa455b5668ab67d216b83828466152dab123fa92384c6ec16b74170';

contract('prepare-amf-headers.sh exists', amfPrep.length > 0, 'missing AMF header prep script');
contract('AMF prep pins official commit ' + COMMIT, amfPrep.includes(COMMIT), 'missing pinned commit');
contract('AMF prep pins official headers SHA256', amfPrep.includes(HEADERS_SHA), 'missing headers digest');
contract('AMF prep pins official license SHA256', amfPrep.includes(LICENSE_SHA), 'missing license digest');
contract('AMF prep installs headers into prefix/include', amfPrep.includes('prefix/include/AMF') || amfPrep.includes('prefix/include'), 'headers not installed');
contract('AMF prep gates on AMF/core/Version.h', amfPrep.includes('Version.h'), 'configure gate header not checked');
contract('AMF prep verifies Factory.h and VideoEncoderVCE.h', amfPrep.includes('AMF/core/Factory.h') && amfPrep.includes('AMF/components/VideoEncoderVCE.h'), 'AMF headers incomplete');
contract('AMF prep writes package license to artifacts/bin', amfPrep.includes('artifacts/bin/WINDOWS-AMF-LICENSE.txt'), 'license not shipped');
contract('AMF prep archives tarball, script and license to corresponding-source', /cp "\$ARCHIVE" "\$SCRIPT" "\$LICENSE" "\$ROOT\/corresponding-source\/"/.test(amfPrep), 'corresponding-source members incomplete');
contract('Windows package requires AMF license member', windowsRelease.includes('resources/bin/WINDOWS-AMF-LICENSE.txt'), 'packaged license gate missing');
contract('Windows notice describes AMF and pinned source', /AMF/.test(ffmpegNotice) && ffmpegNotice.includes(COMMIT) && ffmpegNotice.includes(HEADERS_SHA), 'Windows notice incomplete');
contract('Librempeg notice distinguishes Windows AMF from Linux',
  librempegNotice.includes('Windows enables NVIDIA NVENC and AMD AMF') &&
  librempegNotice.includes('Linux x64 enables NVIDIA NVENC') &&
  librempegNotice.includes('build AMD AMF'),
  'Librempeg platform notice missing');

contract('FFmpeg Windows runs AMF header prep', ffwin.includes('prepare-amf-headers.sh'), 'prep not invoked');
contract('FFmpeg Windows configures --enable-amf', ffwin.includes('--enable-amf'), 'amf not enabled');
contract('FFmpeg Windows enables h264_amf encoder', ffwin.includes('--enable-encoder=h264_amf'), 'h264_amf encoder not enabled');
contract('FFmpeg Windows asserts CONFIG_H264_AMF_ENCODER', ffwin.includes('CONFIG_H264_AMF_ENCODER 1'), 'config not asserted');

contract('Librempeg Windows only runs AMF header prep', /if \[\[ "\$TARGET" == win-x64 \]\]; then\s+bash [^\n]*prepare-amf-headers\.sh/.test(librempeg), 'prep not scoped to Windows');
contract('Librempeg Windows configures --enable-amf', librempeg.includes('--enable-amf'), 'amf not enabled');
contract('Librempeg Windows enables h264_amf encoder', librempeg.includes('h264_amf'), 'h264_amf not in encoders');
const linuxStart = librempeg.indexOf('elif [[ "$TARGET" == linux-x64 ]]; then');
const linuxEnd = librempeg.indexOf('\nelse', linuxStart);
const linuxBlock = linuxStart >= 0 && linuxEnd > linuxStart ? librempeg.slice(linuxStart, linuxEnd) : '';
contract('Librempeg Linux branch excludes AMF', linuxBlock.length > 0 && !/amf/i.test(linuxBlock), 'linux branch leaks AMF');

contract('Linux FFmpeg excludes AMF', !/amf/i.test(fflinux), 'linux ffmpeg unexpectedly enables AMF');

contract('Windows media cache key includes AMF prep', /windows-media-\$\{\{ hashFiles\('[^)]*prepare-amf-headers\.sh[^)]*'\) \}\}/.test(workflow), 'media cache key stale');
contract('Windows librempeg cache key includes AMF prep', /windows-librempeg-\$\{\{ hashFiles\('[^)]*prepare-amf-headers\.sh[^)]*'\) \}\}/.test(workflow), 'librempeg cache key stale');
contract('Windows app cache key includes NV and AMF prep', /windows-update-v2-[^\n]*prepare-nv-codec-headers\.sh[^\n]*prepare-amf-headers\.sh/.test(workflow), 'app cache key stale');
contract('Windows cache miss never routes through rejected historical media reuse', !workflow.includes('reuse-release-media.py'), 'historical media reuse keeps build_only broken after build-script changes');
contract('Windows build_only toolchain installs on a media cache miss',
  workflow.includes("name: Install Windows media build toolchain") &&
  !workflow.includes("if: ${{ !inputs.build_only && (steps.media-cache.outputs.cache-hit != 'true' || steps.librempeg-cache.outputs.cache-hit != 'true') }}"),
  'build_only skips the toolchain needed to build current media');
contract('Windows build_only builds current FFmpeg on cache miss',
  workflow.includes('bash scripts/build-ffmpeg-source-win.sh') &&
  !workflow.includes("if: ${{ !inputs.build_only && steps.media-cache.outputs.cache-hit != 'true' }}"),
  'build_only can reuse historical FFmpeg');
contract('Windows build_only builds current Librempeg on cache miss',
  workflow.includes('bash scripts/build-librempeg-source.sh') &&
  !workflow.includes("if: ${{ !inputs.build_only && steps.librempeg-cache.outputs.cache-hit != 'true' }}"),
  'build_only can reuse historical Librempeg');
contract('Windows media combine step makes no unchanged claim',
  workflow.includes('name: Combine FFmpeg and matching ByteVC2 helper artifacts') &&
  !workflow.includes('Combine unchanged FFmpeg and matching ByteVC2 helper artifacts'),
  'combine step misstates current-source media');
contract('Linux media cache key excludes AMF prep', !/linux-x64-media-[^\n]*prepare-amf-headers/.test(linuxWorkflow), 'linux cache key should not change');

if (failures.length) {
  console.error('\n' + failures.length + ' Windows AMF build contract violation(s)');
  process.exitCode = 1;
} else {
  console.log('\nAll Windows AMF build contract checks passed');
}
