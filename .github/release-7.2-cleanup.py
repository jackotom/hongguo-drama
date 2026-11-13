#!/usr/bin/env python3
"""Remove only exact transport-receipt chunks after verifying all 25 final assets."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import subprocess
import zipfile

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('release-7.2-cloud.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
ARTIFACT, RUN = 14017049239, 43383497350
CONTROL = '50803f73361b4933a6cb62474d9700c52d105af0'
ZIP_SHA = '9b1ea64285debf4d9825a61afeb659722c1b4f678ee62ea15b1e5d648956de44'
RECEIPT_SHA = 'c00702cc4e3b0f11ceb8b7dbdf3961e7c172389dac5212f7e1e2ff2bb6cec69f'

def inputs(archive):
    root = Path(__file__).parent
    paths = [root / ('release-7.2-' + name + '.json') for name in ('transport', 'upload-plan', 'artifact-binding')]
    plan, assembly, binding = [json.loads(p.read_text()) for p in paths]
    t.require(t.record(paths[0])['sha256'] == 'a5a18b326f844800a1ca8beffebe37e6d11256d2e305bd3a62ae6ea55427a879', 'Plan changed')
    planned = t.validate(plan, assembly, binding, t.record(paths[1])['sha256'], t.record(paths[2])['sha256'])
    t.require(t.record(archive) == {'size': 5775, 'sha256': ZIP_SHA}, 'Original verification ZIP changed')
    with zipfile.ZipFile(archive) as z:
        t.require(z.namelist() == ['transport-result.json'], 'Unexpected receipt ZIP members')
        data = z.read('transport-result.json')
    t.require(hashlib.sha256(data).hexdigest() == RECEIPT_SHA, 'Receipt bytes changed')
    receipt = json.loads(data)
    t.require(receipt['releaseId'] == t.DRAFT_ID and receipt['sourceCommit'] == t.FROZEN and receipt['assetCount'] == 25 and receipt['published'] is False and receipt['reassemblyPassed'] and receipt['originalCiZipBindingVerified'] and receipt['manifestsReadBack'], 'Receipt gate failed')
    parts = receipt['temporaryChunks']
    t.require(receipt['temporaryChunkCount'] == len(parts) == len({p['id'] for p in parts}) == len({p['name'] for p in parts}) == 113, 'Exact 113 receipt chunks required')
    for p in parts:
        t.require(set(p) == {'id', 'name', 'size', 'sha256'} and type(p['id']) is int and p['id'] > 0 and p['name'] in planned and {k: p[k] for k in ('name', 'size', 'sha256')} == planned[p['name']], 'Unbound chunk rejected')
    return plan, parts

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', type=Path)
    parser.add_argument('--execute')
    args = parser.parse_args()
    if args.self_check:
        plan, parts = inputs(args.self_check)
        print('PASS original ZIP/receipt, 25 final identities and 113 uniquely bound chunks; no API mutation')
        return
    t.require(args.execute == t.FROZEN, 'Exact frozen source authorization required')
    run = t.api(f'repos/{t.REPO}/actions/runs/{RUN}')
    t.require(run['head_sha'] == CONTROL and run['run_attempt'] == 1 and run['event'] == 'workflow_dispatch' and run['path'] == '.github/workflows/release-7.2-upload.yml' and run['conclusion'] == 'success', 'Original successful transport provenance changed')
    meta = t.api(f'repos/{t.REPO}/actions/artifacts/{ARTIFACT}')
    t.require(meta['workflow_run']['id'] == RUN and meta['workflow_run']['head_sha'] == CONTROL and meta['name'] == 'release-7.2-transport-verification' and meta['size_in_bytes'] == 5775 and meta['digest'] == 'sha256:' + ZIP_SHA, 'Original artifact provenance changed')
    archive = Path('cleanup-original-verification.zip')
    t.api(f'repos/{t.REPO}/actions/artifacts/{ARTIFACT}/zip', destination=archive)
    plan, parts = inputs(archive)
    bound = {p['name']: p for p in parts}
    t.draft()
    rows = t.remote_rows()
    t.check_remote(rows, plan, bound)
    t.require(t.EXPECTED <= set(rows) and all(t.matches(rows[n], plan['assets'][n]) for n in t.EXPECTED), 'Final assets incomplete; chunks retained')
    absent, deleted = [], []
    for p in parts:
        if p['name'] not in rows:
            absent.append(p['id'])
            continue
        row = rows[p['name']]
        t.require(row['id'] == p['id'] and t.matches(row, p), 'Changed asset preserved')
        current = t.api(f'repos/{t.REPO}/releases/assets/{p["id"]}')
        t.require(current['id'] == p['id'] and current['name'] == p['name'] and t.matches(current, p), 'Changed asset preserved before deletion')
        t.draft()
        subprocess.run(['gh', 'api', f'repos/{t.REPO}/releases/assets/{p["id"]}', '--method', 'DELETE'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deleted.append(p['id'])
    t.draft()
    rows = t.remote_rows()
    t.require(set(rows) == t.EXPECTED and all(t.matches(rows[n], plan['assets'][n]) for n in rows), 'Final inventory not exactly 25 matching assets')
    for name in ('latest.yml', 'latest-mac.yml', 'SHA256SUMS.txt'):
        t.download_asset(rows[name], Path('cleanup-readback') / name, plan['assets'][name])
    result = {'sourceCommit': t.FROZEN, 'releaseId': t.DRAFT_ID, 'formalAssetCount': 25, 'totalBytes': sum(v['size'] for v in plan['assets'].values()), 'temporaryChunksDeleted': 113, 'deletedInThisRun': deleted, 'alreadyAbsentIds': absent, 'manifestReadBackCount': 3, 'transportArtifactDigest': 'sha256:' + ZIP_SHA, 'assets': list(rows.values()), 'readyToPublish': True, 'published': False}
    Path('cleanup-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'PASS exactly 25 final assets; deleted {len(deleted)}, already absent {len(absent)}, all 113 receipt chunks absent; three manifests read back; draft retained')

if __name__ == '__main__':
    main()
