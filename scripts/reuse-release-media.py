#!/usr/bin/env python3
"""Restore pinned 6.5 media without executing an image, helper or application."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
REPO = 'jackotom/hongguo-drama'
OLD_SHA = 'b99555519d97065b16753cd66326eb62894ec34a'
DOCKER_NAME = 'hongguo-drama-6.5-docker-amd64.tar.gz'
DOCKER_SHA = '794fea0c49837e075521d3b62d7f831ef3baf93672fcbee11e3c29a5c82e7292'
INPUTS = ['build-ffmpeg-source-mac.sh', 'build-ffmpeg-source-mac-x64.sh',
          'build-librempeg-source.sh', 'librempeg-videotoolbox-prototype.patch',
          'software-player-assets.json', 'setup-software-player.cjs',
          'build-ffmpeg-source-win.sh', 'build-ffmpeg-source-linux.sh']
SOURCES = {
    'linux-x64': [('ffmpeg-9.0.2-x264-b35605a-linux-x64-corresponding-source.tar.gz', 13170081,
                   'e176d05ccb764754861c6f1736cab7e24f6e31779ff0cd16c0d82685286bbe6d'),
                  ('librempeg-cb1f8f3-x264-b35605a-linux-x64-corresponding-source.tar.gz', 19876967,
                   'd4c67f5fda33c0deb5d6969574e8f215e434a79570c45b45aed0cb3e326609e1')],
    'win-x64': [('ffmpeg-9.0.2-x264-b35605a-win-x64-corresponding-source.tar.gz', 13202581,
                 '422dcb4a4eb22119400740bee19cf84d8e2925f90f31fd1d8c32f545ea162d9e'),
                ('librempeg-cb1f8f3-x264-b35605a-win-x64-corresponding-source.tar.gz', 19876967,
                 'd4c67f5fda33c0deb5d6969574e8f215e434a79570c45b45aed0cb3e326609e1')],
}
WINDOWS_SHA = {
    'ffmpeg.exe': 'cd02a7bbeb73082ba02edee235d3c00818b813312b36036611a3f9d98fb1757f',
    'ffprobe.exe': 'db1a4109c72c401da02b35257b783eecac657d14bbf513c4f28e04696f33c237',
    'librempeg.exe': 'be6bb87b02efad803bf82c877abd1c667d99db84d6816e7cd2ebd3fa019b676b',
}
LICENSES = {'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3',
            'LICENSE.md', 'LINUX-X264-LICENSE.txt', 'LIBREMPEG-COPYING.AGPLv3',
            'LIBREMPEG-COPYING.GPLv3', 'LIBREMPEG-LICENSE.md', 'LIBREMPEG-X264-LICENSE.txt'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def output(*args):
    return subprocess.check_output(args, cwd=ROOT)


def api(endpoint):
    return json.loads(output('gh', 'api', '--method', 'GET', endpoint))


def verify_inputs():
    if subprocess.run(['git', 'cat-file', '-e', OLD_SHA], cwd=ROOT, capture_output=True).returncode:
        subprocess.run(['git', 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', OLD_SHA], cwd=ROOT, check=True)
    for name in INPUTS:
        relative = 'scripts/' + name
        require(output('git', 'show', OLD_SHA + ':' + relative) == (ROOT / relative).read_bytes(),
                'Media input changed; cannot reuse 6.5: ' + relative)


def published_asset(release, folder, name, size, sha):
    rows = [row for row in release['assets'] if row['name'] == name]
    require(len(rows) == 1, 'Missing unique published asset: ' + name)
    row = rows[0]
    require(row['size'] == size and row.get('digest') == 'sha256:' + sha and row['state'] == 'uploaded',
            'Published asset metadata differs: ' + name)
    target = folder / name
    with target.open('wb') as stream:
        subprocess.run(['gh', 'api', '--method', 'GET', '-H', 'Accept: application/octet-stream',
                        'repos/' + REPO + '/releases/assets/' + str(row['id'])], stdout=stream, check=True)
    require(target.stat().st_size == size and digest(target) == sha, 'Asset bytes differ: ' + name)
    return target


def extract_linux(archive, destination):
    require(archive.stat().st_size == 107328918 and digest(archive) == DOCKER_SHA, 'Docker archive digest differs')
    files = {}
    with tarfile.open(archive, 'r:gz') as image:
        manifest = json.load(image.extractfile('manifest.json'))
        require(len(manifest) == 1 and manifest[0]['RepoTags'] == ['hongguo-drama:6.5'], 'Unexpected image manifest')
        config = json.load(image.extractfile(manifest[0]['Config']))
        require(config['os'] == 'linux' and config['architecture'] == 'amd64', 'Image platform differs')
        require(config['config']['Labels']['org.opencontainers.image.revision'] == OLD_SHA, 'Image revision differs')
        for layer_name in manifest[0]['Layers']:
            with tarfile.open(fileobj=image.extractfile(layer_name), mode='r|*') as layer:
                for member in layer:
                    path = PurePosixPath(member.name)
                    if path.parent != PurePosixPath('usr/local/bin'):
                        continue
                    name = path.name
                    require(not name.startswith('.wh.'), 'Unexpected whiteout in pinned media directory')
                    if name not in LICENSES | {'ffmpeg', 'ffprobe', 'librempeg'}:
                        continue
                    require(member.isfile(), 'Media member is not a regular file: ' + name)
                    files[name] = layer.extractfile(member).read()
    require(LICENSES <= files.keys(), 'Media license files missing')
    for name in ['ffmpeg', 'ffprobe', 'librempeg']:
        header = files[name][:20]
        require(header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == 62,
                'Media is not Linux x64 ELF: ' + name)
    for name, data in files.items():
        family = 'librempeg' if name.startswith('LIBREMPEG-') or name == 'librempeg' else 'ffmpeg'
        target = destination / family / 'artifacts/bin' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if name in {'ffmpeg', 'ffprobe', 'librempeg'} else 0o644)


def restore_windows(folder, destination):
    run = api('repos/' + REPO + '/actions/runs/42599445105')
    require(run['head_sha'] == OLD_SHA and run['conclusion'] == 'success' and
            run['repository']['full_name'] == REPO, 'Historical Windows run identity differs')
    subprocess.run(['gh', 'run', 'download', '42599445105', '--repo', REPO,
                    '--name', 'windows-media', '--dir', str(folder)], check=True)
    for name, expected in WINDOWS_SHA.items():
        file = folder / 'bin' / name
        require(file.is_file() and not file.is_symlink() and digest(file) == expected, 'Windows media digest differs: ' + name)
    for file in (folder / 'bin').iterdir():
        require(file.is_file() and not file.is_symlink(), 'Unexpected Windows media entry')
        family = 'librempeg' if file.name.startswith('LIBREMPEG-') or file.name == 'librempeg.exe' else 'ffmpeg'
        target = destination / family / 'artifacts/bin' / file.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in SOURCES, 'Usage: reuse-release-media.py linux-x64|win-x64 OUTPUT')
    platform, destination = sys.argv[1], Path(sys.argv[2]).resolve()
    verify_inputs()
    release = api('repos/' + REPO + '/releases/tags/v6.5')
    require(release['tag_name'] == 'v6.5' and not release['draft'] and not release['prerelease'], 'Expected public stable 6.5')
    with tempfile.TemporaryDirectory(prefix='media-reuse-') as temp:
        folder = Path(temp)
        if platform == 'linux-x64':
            extract_linux(published_asset(release, folder, DOCKER_NAME, 107328918, DOCKER_SHA), destination)
        else:
            restore_windows(folder / 'windows', destination)
        for name, size, sha in SOURCES[platform]:
            source = published_asset(release, folder, name, size, sha)
            target = destination / ('librempeg' if name.startswith('librempeg') else 'ffmpeg') / 'artifacts' / name
            shutil.copyfile(source, target)
    print('Restored pinned 6.5 ' + platform + ' media and sources; eight inputs unchanged; no binaries executed')


if __name__ == '__main__':
    main()
