#!/usr/bin/env python3
"""Controller-authorized exact v6.9.4 draft transport; never publish or alter another asset."""
from pathlib import Path, PurePosixPath
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.parse
import zipfile

FROZEN = 'b364419c2b81da3a7e28fd637011aaff9b8acf2c'
DRAFT_ID = 441185875
REPO, TAG = 'jackotom/hongguo-drama', 'v6.9'
PREFIX = '_hg69-' + FROZEN[:7] + '-'
ANNOTATED_TAGS = {}  # Content-addressed objects only; never cache release state or mutable refs.
EXPECTED = {'hongguo-drama-6.9-docker-deploy.zip', 'ffmpeg-9.0.2-x264-b35605a-linux-x64-corresponding-source.tar.gz', 'hongguo-downloader-6.9-win-x64.exe', 'SHA256SUMS.txt', 'hongguo-downloader-6.9-mac-x64.zip', 'hongguo-downloader-6.9-win-x64-setup.exe', 'librempeg-cb1f8f3-x264-b35605a-x64-corresponding-source.tar.gz', 'hongguo-downloader-6.9-win-x64.zip', 'hongguo-drama-6.9-source.zip', 'latest.yml', 'Hongguo-6.9-mac-arm64.dmg', 'librempeg-cb1f8f3-x264-b35605a-linux-x64-corresponding-source.tar.gz', 'libmedia-1.3.1-152f629-corresponding-source.tar.gz', 'hongguo-downloader-6.9-mac-arm64.zip', 'ffmpeg-9.0.2-x264-b35605a-x64-corresponding-source.tar.gz', 'hongguo-downloader-6.9-win-x64-setup.exe.blockmap', 'hongguo-downloader-6.9-windows-source.zip', 'ffmpeg-9.0.2-x264-b35605a-corresponding-source.tar.gz', 'Hongguo-6.9-mac-x64.dmg', 'librempeg-cb1f8f3-x264-b35605a-win-x64-corresponding-source.tar.gz', 'latest-mac.yml', 'hongguo-drama-6.9-docker-amd64.tar.gz', 'librempeg-cb1f8f3-x264-b35605a-arm64-corresponding-source.tar.gz', 'hongguo-downloader-6.9-linux-x64.AppImage', 'ffmpeg-9.0.2-x264-b35605a-win-x64-corresponding-source.tar.gz'}
CI = {
 'windows-x64': {'runId': 42983178306, 'workflow': '.github/workflows/windows.yml', 'artifacts': {13838323150: 'windows-release-candidate', 13838502435: 'windows-verification'}},
 'linux-x64': {'runId': 42983150620, 'workflow': '.github/workflows/linux.yml', 'artifacts': {13838118864: 'linux-appimage-candidate'}},
 'docker-amd64': {'runId': 42983150721, 'workflow': '.github/workflows/docker.yml', 'artifacts': {13838920779: 'docker-server-candidate'}},
}
REMOTE = {
 'windows': {'hongguo-downloader-6.9-win-x64.exe', 'hongguo-downloader-6.9-win-x64.zip', 'hongguo-downloader-6.9-win-x64-setup.exe', 'hongguo-downloader-6.9-win-x64-setup.exe.blockmap', 'latest.yml', 'ffmpeg-9.0.2-x264-b35605a-win-x64-corresponding-source.tar.gz', 'librempeg-cb1f8f3-x264-b35605a-win-x64-corresponding-source.tar.gz'},
 'linux': {'hongguo-downloader-6.9-linux-x64.AppImage', 'ffmpeg-9.0.2-x264-b35605a-linux-x64-corresponding-source.tar.gz', 'librempeg-cb1f8f3-x264-b35605a-linux-x64-corresponding-source.tar.gz'},
 'docker': {'hongguo-drama-6.9-docker-amd64.tar.gz'},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def record(path):
    require(path.is_file() and not path.is_symlink(), 'Physical input file required')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return {'size': path.stat().st_size, 'sha256': h.hexdigest()}


def valid_record(value):
    return isinstance(value, dict) and set(value) == {'size', 'sha256'} and type(value['size']) is int and value['size'] > 0 and re.fullmatch('[0-9a-f]{64}', value['sha256'] or '') is not None


def safe_name(name):
    return isinstance(name, str) and name not in ('', '.', '..') and Path(name).name == name and '/' not in name and chr(92) not in name


def safe_member(name):
    raw = PurePosixPath(name)
    return bool(name) and not raw.is_absolute() and '..' not in raw.parts and chr(92) not in name and raw.as_posix() == name.rstrip('/')


def validate(plan, assembly, binding, assembly_sha, binding_sha):
    for item in (plan, assembly, binding):
        require(item.get('sourceCommit') == FROZEN and item.get('version') == '6.9.0' and item.get('buildVersion') == '6.9.4', 'Exact final4 source/version required')
    require(plan.get('releaseId') == DRAFT_ID and plan.get('transport_authorized') is True, 'Explicit final4 draft transport authorization required')
    require(plan.get('uploadPlanSha256') == assembly_sha and assembly.get('assembly_status') == 'complete' and assembly.get('tag') == TAG and assembly.get('assetCount') == 25, 'Complete hashed assembly plan required')
    require(assembly.get('gateReceiptFiles', {}).get('artifact-binding.json', {}).get('sha256') == binding_sha, 'Hashed CI binding differs from accepted assembly')
    require(set(plan.get('assets', {})) == EXPECTED and plan['assets'] == assembly.get('assets') and len(EXPECTED) == 25, 'Exact 25 asset identities required')
    require(all(safe_name(name) and valid_record(value) for name, value in plan['assets'].items()), 'Invalid final asset size/hash')
    require(plan.get('priorMediaAssets') == {} and plan.get('interruptedAssetIds') == {}, 'Old-release reuse and non-chunk deletion forbidden')
    require({name: set(values) for name, values in plan.get('remoteArtifacts', {}).items()} == REMOTE, 'Exact current CI output map required')
    require(set(binding.get('platforms', {})) == set(CI), 'Exact CI binding platforms required')
    for platform, expected in CI.items():
        row = binding['platforms'][platform]
        require(row.get('runId') == expected['runId'] and row.get('runAttempt') == 1 and row.get('sourceCommit') == FROZEN and row.get('version') == '6.9.0' and row.get('buildVersion') == '6.9.4', 'Bound current CI run required')
        artifacts = row.get('artifacts', [])
        require(len(artifacts) == len(expected['artifacts']) and {a.get('id'): a.get('name') for a in artifacts} == expected['artifacts'], 'Exact current CI artifact IDs required')
        for a in artifacts:
            require(a.get('archive') == 'artifact-' + str(a['id']) + '.zip' and valid_record(assembly['gateReceiptFiles'].get(a['archive'])), 'Accepted original ZIP record required')
            require(isinstance(a.get('files'), dict) and a['files'] and len(set(a['files'].values())) == len(a['files']), 'Unambiguous original ZIP member mapping required')
            directory = platform.split('-')[0]
            for relative, member in a['files'].items():
                require(safe_member(relative) and relative.startswith(directory + '/') and safe_member(member) and valid_record(assembly['gateReceiptFiles'].get(relative)), 'Unsafe or unbound original ZIP member')
    remote_names = set().union(*REMOTE.values())
    require(set(plan.get('localParts', {})) == EXPECTED - remote_names - {'SHA256SUMS.txt'}, 'All current local Mac/source/media assets must be freshly chunked')
    parts = {}
    for name, group in plan['localParts'].items():
        require(isinstance(group, list) and group and sum(p.get('size', 0) for p in group) == plan['assets'][name]['size'], 'Missing or wrong-size local part group')
        for part in group:
            require(set(part) == {'name', 'size', 'sha256'} and safe_name(part['name']) and re.fullmatch(re.escape(PREFIX) + '[0-9a-f]{12,64}-[0-9]{3,6}[.]part', part['name']) is not None and valid_record({k: part[k] for k in ('size', 'sha256')}) and part['size'] <= 8 * 1024 * 1024, 'Unsafe or oversized transport chunk')
            if part['name'] in parts:
                require(parts[part['name']] == part, 'Conflicting duplicate transport chunk')
            parts[part['name']] = part
    require(plan.get('uniqueChunkCount') == len(parts), 'Exact unique chunk count required')
    return parts


def api(endpoint, method='GET', destination=None):
    require(method in ('GET', 'DELETE'), 'Unsupported API operation')
    command = ['gh', 'api', '--method', method, endpoint]
    if destination is not None:
        require(method == 'GET', 'Binary API operation must be read only')
        media = 'application/vnd.github+json' if endpoint.startswith(f'repos/{REPO}/actions/artifacts/') else 'application/octet-stream'
        command += ['-H', 'Accept: ' + media]
        for attempt in range(3):
            with destination.open('xb') as stream:
                process = subprocess.run(command, stdout=stream, stderr=subprocess.PIPE,
                    env={**os.environ, 'GODEBUG': 'http2client=0'})
            if process.returncode == 0:
                return None
            destination.unlink()  # Only this attempt's newly created partial transport file.
            if attempt < 2:
                time.sleep(1)
        status = re.findall(rb'HTTP ([0-9]{3})', process.stderr)
        raise ValueError('GitHub binary read failed: ' + endpoint + '; exit=' + str(process.returncode) + '; HTTP=' + (status[-1].decode() if status else 'unknown'))
    result = subprocess.run(command, capture_output=True)
    if method == 'DELETE' and result.returncode and b'HTTP 404' in result.stderr:
        return None
    require(result.returncode == 0, 'GitHub API operation failed')
    return json.loads(result.stdout) if result.stdout else None


def draft():
    release = api(f'repos/{REPO}/releases/{DRAFT_ID}')
    require(release.get('id') == DRAFT_ID and release.get('draft') is True and release.get('prerelease') is False and release.get('tag_name') == TAG and release.get('target_commitish') == FROZEN and 'published_at' in release and release['published_at'] is None, 'Specified draft state changed')
    obj = api(f'repos/{REPO}/git/ref/tags/{TAG}')['object']
    for _ in range(4):
        if obj.get('type') == 'commit':
            break
        require(obj.get('type') == 'tag' and re.fullmatch('[0-9a-f]{40}', obj.get('sha', '')), 'Unexpected tag target')
        oid = obj['sha']
        if oid not in ANNOTATED_TAGS:
            immutable = api(f'repos/{REPO}/git/tags/' + oid)
            require(immutable.get('sha') == oid, 'Annotated tag object SHA differs from requested OID')
            ANNOTATED_TAGS[oid] = immutable['object']
        obj = ANNOTATED_TAGS[oid]
    require(obj.get('type') == 'commit' and obj.get('sha') == FROZEN, 'Frozen release tag changed')


def remote_rows():
    rows = []
    for page in range(1, 4):
        batch = api(f'repos/{REPO}/releases/{DRAFT_ID}/assets?per_page=100&page={page}')
        rows += batch
        if len(batch) < 100:
            require(len({r['name'] for r in rows}) == len(rows), 'Duplicate remote asset names')
            return {r['name']: r for r in rows}
    raise ValueError('Unexpected draft inventory size')


def matches(row, expected):
    return row.get('state') == 'uploaded' and row.get('size') == expected['size'] and row.get('digest') == 'sha256:' + expected['sha256']


def check_remote(rows, plan, parts):
    require(set(rows) <= EXPECTED | set(parts), 'Unexpected draft assets preserved; transport stopped')
    for name, row in rows.items():
        require(matches(row, plan['assets'][name] if name in EXPECTED else parts[name]), 'Conflicting remote asset preserved')


def verify(path, expected):
    require(record(path) == {key: expected[key] for key in ('size', 'sha256')}, 'File size/SHA256 mismatch: ' + path.name)


def fetch_ci(binding, assembly):
    for platform, expected in CI.items():
        row = binding['platforms'][platform]
        run = api(f'repos/{REPO}/actions/runs/{expected["runId"]}')
        require(run.get('id') == expected['runId'] and run.get('head_sha') == FROZEN and run.get('run_attempt') == 1 and run.get('event') == 'workflow_dispatch' and run.get('path') == expected['workflow'] and run.get('status') == 'completed' and run.get('conclusion') == 'success', 'Current successful CI provenance changed')
        for a in row['artifacts']:
            expected_zip = assembly['gateReceiptFiles'][a['archive']]
            metadata = api(f'repos/{REPO}/actions/artifacts/{a["id"]}')
            require(metadata.get('id') == a['id'] and metadata.get('name') == a['name'] and metadata.get('expired') is False and metadata.get('workflow_run', {}).get('id') == expected['runId'] and metadata.get('workflow_run', {}).get('head_sha') == FROZEN and metadata.get('digest') == 'sha256:' + expected_zip['sha256'], 'Original CI ZIP/API digest binding changed')
            archive = Path('transport/ci-archives') / a['archive']
            archive.parent.mkdir(parents=True, exist_ok=True)
            api(f'repos/{REPO}/actions/artifacts/{a["id"]}/zip', destination=archive)
            verify(archive, expected_zip)
            with zipfile.ZipFile(archive) as z:
                names = z.namelist()
                require(len(names) == len(set(names)) and all(safe_member(name) for name in names), 'Unsafe/duplicate original ZIP paths')
                for relative, member in a['files'].items():
                    info = z.getinfo(member)
                    require(not info.is_dir() and not stat.S_ISLNK(info.external_attr >> 16), 'Non-file original ZIP member rejected')
                    target = Path('transport') / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(member) as source, target.open('xb') as output:
                        for chunk in iter(lambda: source.read(1024 * 1024), b''):
                            output.write(chunk)
                    verify(target, assembly['gateReceiptFiles'][relative])
        require((Path('transport') / platform.split('-')[0] / 'SOURCE-SHA.txt').read_text(encoding='utf-8-sig').strip() == FROZEN, 'CI extracted source identity changed')


def download_asset(row, destination, expected):
    destination.parent.mkdir(parents=True, exist_ok=True)
    api(f'repos/{REPO}/releases/assets/{row["id"]}', destination=destination)
    verify(destination, expected)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', required=True)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--assembly-plan', required=True)
    parser.add_argument('--binding', required=True)
    args = parser.parse_args()
    require(args.execute == FROZEN and re.fullmatch('[0-9a-f]{64}', args.plan_sha256 or ''), 'Explicit exact-source execution and plan hash required')
    plan_path, assembly_path, binding_path = map(Path, (args.plan, args.assembly_plan, args.binding))
    require(record(plan_path)['sha256'] == args.plan_sha256, 'Transport plan digest differs from controller input')
    plan, assembly, binding = [json.loads(p.read_text()) for p in (plan_path, assembly_path, binding_path)]
    parts = validate(plan, assembly, binding, record(assembly_path)['sha256'], record(binding_path)['sha256'])
    draft()
    rows = remote_rows()
    check_remote(rows, plan, parts)
    fetch_ci(binding, assembly)
    for attempt in range(180):
        draft()
        rows = remote_rows()
        check_remote(rows, plan, parts)
        needed_names = {p['name'] for name, group in plan['localParts'].items() if name not in rows for p in group}
        if needed_names <= set(rows) and 'SHA256SUMS.txt' in rows:
            break
        if attempt % 12 == 0:
            print('WAIT verified current chunks: ' + str(len(set(parts) - set(rows))), flush=True)
        time.sleep(5)
    else:
        raise ValueError('Current temporary chunks/manifest incomplete; draft preserved')
    download_asset(rows['SHA256SUMS.txt'], Path('transport/seed/SHA256SUMS.txt'), plan['assets']['SHA256SUMS.txt'])
    candidates = {name: Path('transport') / platform / name for platform, names in REMOTE.items() for name in names}
    for name, path in candidates.items():
        verify(path, plan['assets'][name])
    needed = {part['name']: part for name, group in plan['localParts'].items() if name not in rows for part in group}
    def fetch_part(name):
        return download_asset(rows[name], Path('transport/parts') / name, needed[name])
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch_part, needed))
    for name, group in plan['localParts'].items():
        if name in rows:
            continue
        path = Path('transport/assembled') / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            for part in group:
                with (Path('transport/parts') / part['name']).open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        output.write(chunk)
        verify(path, plan['assets'][name])
        candidates[name] = path
    def upload(name):
        draft()
        current = remote_rows()
        check_remote(current, plan, parts)
        if name in current:
            return
        subprocess.run(['gh', 'release', 'upload', TAG, '--repo', REPO, str(candidates[name])], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        print('UPLOADED ' + name, flush=True)
    # Serialize writes so strict inventory checks cannot observe another in-flight asset.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        list(pool.map(upload, candidates))
    draft()
    rows = remote_rows()
    check_remote(rows, plan, parts)
    require(EXPECTED <= set(rows) and all(matches(rows[name], plan['assets'][name]) for name in EXPECTED), 'Final 25 assets not complete; chunks retained')
    for name in ('latest.yml', 'latest-mac.yml', 'SHA256SUMS.txt'):
        download_asset(rows[name], Path('transport/manifest-readback') / name, plan['assets'][name])
    require(set(rows) == EXPECTED | set(parts), 'Expected formal assets and current chunks required')
    Path('transport-result.json').write_text(json.dumps({'reassemblyPassed': True, 'releaseId': DRAFT_ID, 'sourceCommit': FROZEN, 'version': '6.9.0', 'buildVersion': '6.9.4', 'assetCount': 25, 'temporaryChunkCount': len(parts), 'controllerCleanupRequired': True, 'originalCiZipBindingVerified': True, 'manifestsReadBack': True, 'published': False}, indent=2) + '\n')
    print('PASS exact 25 formal assets and manifests; controller must verify/clean current chunks before publication')



if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Transport stopped: ' + (str(error) if type(error) is ValueError else type(error).__name__), file=sys.stderr)
        sys.exit(1)
