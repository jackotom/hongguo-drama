from pathlib import Path
import concurrent.futures
import hashlib
import json
import subprocess
import time

plan = json.loads(Path('.github/release-6.7-transport.json').read_text())
rid = plan['releaseId']
assert rid == 440494074

def api(endpoint, method='GET'):
    for attempt in range(3):
        result = subprocess.run(['gh', 'api', '--method', method, endpoint], capture_output=True)
        if result.returncode == 0:
            return json.loads(result.stdout) if result.stdout else None
        time.sleep(1)
    raise RuntimeError(f'GitHub {method} failed: {endpoint}')

def rows():
    result = []
    for page in range(1, 4):
        batch = api(f'repos/jackotom/hongguo-drama/releases/{rid}/assets?per_page=100&page={page}')
        result.extend(batch)
        if len(batch) < 100:
            return {row['name']: row for row in result}
    raise RuntimeError('Unexpected draft inventory')

def draft():
    release = api(f'repos/jackotom/hongguo-drama/releases/{rid}')
    assert release['draft'] and release['tag_name'] == 'v6.7'

def matches(row, expected):
    return row['state'] == 'uploaded' and row['size'] == expected['size'] and row.get('digest') == 'sha256:' + expected['sha256']

def verify(path, expected):
    assert path.is_file() and path.stat().st_size == expected['size']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected['sha256'], path.name

def download(asset_id, destination, expected):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('wb') as stream:
        subprocess.run(['gh', 'api', f'repos/jackotom/hongguo-drama/releases/assets/{asset_id}', '-H', 'Accept: application/octet-stream'], stdout=stream, check=True)
    verify(destination, expected)
    return destination

draft()
tag = api('repos/jackotom/hongguo-drama/git/ref/tags/v6.7')['object']
if tag['type'] == 'tag':
    tag = api('repos/jackotom/hongguo-drama/git/tags/' + tag['sha'])['object']
assert tag['type'] == 'commit' and tag['sha'] == plan['sourceCommit']
initial = rows()
candidates = {}

for platform, names in plan['remoteArtifacts'].items():
    root = Path('transport') / platform
    assert (root / 'SOURCE-SHA.txt').read_text().strip() == plan['sourceCommit']
    for name in names:
        candidates[name] = root / name
        verify(candidates[name], plan['assets'][name])

for name, asset_id in plan['priorMediaAssets'].items():
    if name in initial and matches(initial[name], plan['assets'][name]):
        continue
    candidates[name] = download(asset_id, Path('transport/media') / name, plan['assets'][name])

all_parts = {part['name']: part for group in plan['localParts'].values() for part in group}
assert len(all_parts) == 90 and all(name.startswith('_hg67-43c7b4c-') for name in all_parts)
needed = {}
for name, parts in plan['localParts'].items():
    if name in initial and matches(initial[name], plan['assets'][name]):
        continue
    assert Path(name).name == name
    for part in parts:
        row = initial[part['name']]
        assert matches(row, part)
        needed[part['name']] = part

def fetch_part(name):
    return download(initial[name]['id'], Path('transport/parts') / name, needed[name])

with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    list(pool.map(fetch_part, needed))

for name, parts in plan['localParts'].items():
    if name in initial and matches(initial[name], plan['assets'][name]):
        continue
    output = Path('transport/assembled') / name
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as stream:
        for part in parts:
            stream.write((Path('transport/parts') / part['name']).read_bytes())
    verify(output, plan['assets'][name])
    candidates[name] = output

def upload(name):
    draft()
    current = rows().get(name)
    if current:
        if matches(current, plan['assets'][name]):
            return
        assert current['state'] == 'starter' and current['id'] == plan['interruptedAssetIds'].get(name)
        api(f'repos/jackotom/hongguo-drama/releases/assets/{current["id"]}', 'DELETE')
    subprocess.run(['gh', 'release', 'upload', 'v6.7', '--repo', 'jackotom/hongguo-drama', str(candidates[name])], check=True)
    print('UPLOADED ' + name, flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(upload, candidates))
draft()
current = rows()
assert set(current) <= set(plan['assets']) | set(all_parts)
for name, expected in plan['assets'].items():
    assert matches(current[name], expected), name

def remove_part(name):
    row = current[name]
    assert name in all_parts and matches(row, all_parts[name])
    api(f'repos/jackotom/hongguo-drama/releases/assets/{row["id"]}', 'DELETE')

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(remove_part, set(current) & set(all_parts)))
draft()
current = rows()
assert len(current) == 25 and set(current) == set(plan['assets'])
assert all(matches(current[name], expected) for name, expected in plan['assets'].items())
Path('transport-result.json').write_text(json.dumps({'passed': True, 'releaseId': rid, 'sourceCommit': plan['sourceCommit'], 'assetCount': 25, 'temporaryChunksRemoved': True, 'published': False}, indent=2) + '\n')
print('25 exact assets verified, temporary chunks removed; draft not published')
