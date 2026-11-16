#!/usr/bin/env python3
"""Restore all five approved Mac inputs before replacing any old dictionary asset."""
from pathlib import Path
import argparse, base64, copy, hashlib, importlib.util, json, os, re, subprocess, sys, tempfile
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('windows_transport',Path(__file__).with_name('release-7.5-windows-cloud.py'))
shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
require,record,api,draft,rows,matches=shared.require,shared.record,shared.api,shared.draft,shared.rows,shared.matches
FROZEN,DRAFT=shared.FROZEN,shared.DRAFT
NAMES=['Hongguo-7.5-mac-arm64.dmg','Hongguo-7.5-mac-x64.dmg','hongguo-downloader-7.5-mac-arm64.zip','hongguo-downloader-7.5-mac-x64.zip','latest-mac.yml']
PREFIX='_hg75-4ffff28-'
RESULT=Path('transport-mac-result.json')
receipt={'releaseId':DRAFT,'sourceCommit':FROZEN,'version':'7.5.0','buildVersion':'7.5.2','transportCommit':os.environ.get('GITHUB_SHA'),'passed':False,'restorationPassed':False,'verified':[]}
def save():RESULT.write_text(json.dumps(receipt,indent=2)+'\n')
def valid_file(value):
    return isinstance(value,dict) and type(value.get('size')) is int and 0<value['size']<=2*1024**3 and isinstance(value.get('sha256'),str) and re.fullmatch('[0-9a-f]{64}',value['sha256']) is not None
def validate(plan):
    require(plan.get('mode')=='mac-zstd-delta' and plan.get('status')=='ready' and plan.get('transportAuthorized') is True and plan.get('finalFilesApproved') is True,'Final Mac plan not approved/ready')
    require(plan.get('sourceCommit')==FROZEN and plan.get('version')=='7.5.0' and plan.get('buildVersion')=='7.5.2' and plan.get('releaseId')==DRAFT and plan.get('tag')=='v7.5','Exact Mac candidate/draft binding required')
    require(set(plan.get('assets',{}))==set(NAMES),'Only four Mac files and latest-mac.yml authorized')
    ids=set()
    for name,item in plan['assets'].items():
        require(valid_file(item),'Invalid final size/SHA256')
        for key in ['base','input' if name=='latest-mac.yml' else 'delta']:
            remote=item.get(key)
            require(valid_file(remote) and type(remote.get('id')) is int and remote['id']>0 and remote['id'] not in ids,'Invalid or duplicate input asset ID')
            ids.add(remote['id'])
            require(isinstance(remote.get('name'),str) and re.fullmatch('[A-Za-z0-9._-]{1,180}',remote['name']) and remote['name'] not in ['.','..'],'Unsafe input name')
            require(remote['name']==name if key=='base' else remote['name'].startswith(PREFIX),'Wrong dictionary or temporary input name')
def binding(row,expected):
    return row is not None and row.get('id')==expected['id'] and row.get('name')==expected['name'] and matches(row,expected)
def download(expected,path):
    draft();current=rows()
    require(binding(current.get(expected['name']),expected),'Input ID/state/size/hash changed: '+path.name)
    metadata=api('releases/assets/'+str(expected['id']))
    require(binding(metadata,expected),'Input asset metadata changed: '+path.name)
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as output:
        result=subprocess.run(['gh','api','-H','Accept: application/octet-stream','repos/'+shared.REPO+'/releases/assets/'+str(expected['id'])],stdout=output,stderr=subprocess.PIPE,timeout=300)
    require(result.returncode==0 and record(path)=={k:expected[k] for k in ['size','sha256']},'Downloaded bytes mismatch: '+path.name)
def restore(base,delta,output,expected):
    result=subprocess.run(['zstd','-d','-M512MB','--patch-from='+str(base),str(delta),'-o',str(output)],capture_output=True,timeout=300)
    require(result.returncode==0,'Zstd delta reconstruction failed')
    require(record(output)=={k:expected[k] for k in ['size','sha256']},'Restored full size/SHA256 mismatch')
def check_manifest(directory):
    manifest=(directory/'latest-mac.yml').read_text()
    entries=re.findall(r'^  - url: (\S+)\n    sha512: (\S+)\n    size: (\d+)\s*$',manifest,re.M)
    wanted=set(NAMES[2:4]);observed={}
    for name,sha512,size in entries:
        require(name in wanted and name not in observed,'Unexpected/duplicate Mac update entry')
        path=directory/name
        require(int(size)==path.stat().st_size and sha512==base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode(),'Mac update ZIP SHA512/size mismatch')
        observed[name]=sha512
    path=re.findall(r'^path: (\S+)\s*$',manifest,re.M);digest=re.findall(r'^sha512: (\S+)\s*$',manifest,re.M)
    require(re.findall(r'^version: (\S+)\s*$',manifest,re.M)==['7.5.0'] and len(re.findall(r'^\s*-\s*url:',manifest,re.M))==2 and set(observed)==wanted and len(path)==1 and len(digest)==1 and observed.get(path[0])==digest[0],'Mac update manifest version/paths mismatch')
def reconcile():
    draft();current=rows()
    receipt['remoteReadback']=[{k:current[n].get(k) for k in ['name','id','state','size','digest']} if n in current else {'name':n,'missing':True} for n in NAMES]
    save();return current
def execute(plan):
    require(os.environ.get('GITHUB_REF')=='refs/heads/codex/transport-7.5','Dedicated transport branch required')
    work=Path('transport-mac');output=work/'restored';output.mkdir(parents=True,exist_ok=False)
    current=reconcile()
    for index,name in enumerate(NAMES):
        item=plan['assets'][name]
        if matches(current.get(name),item):
            download(dict(item,id=current[name]['id'],name=name),output/name)
        elif name=='latest-mac.yml':
            require(binding(current.get(name),item['base']),'Exact old Mac manifest changed')
            download(item['input'],output/name)
        else:
            require(binding(current.get(name),item['base']),'Exact old Mac dictionary changed')
            base=work/'bases'/str(index);delta=work/'deltas'/str(index)
            download(item['base'],base);download(item['delta'],delta)
            restore(base,delta,output/name,item)
        require(record(output/name)=={k:item[k] for k in ['size','sha256']},'Final Mac bytes differ: '+name)
    check_manifest(output)
    receipt['restorationPassed']=True;save()
    for name in NAMES:  # Replace the update manifest only after all four large files verify remotely.
        current=reconcile();item=plan['assets'][name];row=current.get(name)
        if not matches(row,item):
            require(binding(row,item['base']),'Conflicting Mac asset preserved: '+name)
            receipt['inFlight']=name;save()
            try:
                result=subprocess.run(['gh','release','upload','v7.5','--repo',shared.REPO,str(output/name),'--clobber'],capture_output=True,timeout=300)
                success=result.returncode==0
            except subprocess.TimeoutExpired:success=False
            current=reconcile()
            require(matches(current.get(name),item),'Mac upload incomplete after reconciliation: '+name)
            receipt['clientReportedSuccess']=success
        row=current[name];receipt['verified'].append({'name':name,'id':row['id'],'size':row['size'],'sha256':item['sha256']});receipt.pop('inFlight',None);save()
        print('VERIFIED '+name,flush=True)
    current=reconcile();require(all(matches(current.get(n),plan['assets'][n]) for n in NAMES),'Final five Mac assets not verified')
    receipt['passed']=True;receipt['draftStillUnpublished']=True;save()
    print('PASS five final Mac draft assets; no notarization, publication, tag or temporary-input cleanup')
def self_check():
    template=json.loads(Path(__file__).with_name('release-7.5-mac-transport.example.json').read_text())
    def rejected(value):
        try:validate(value)
        except ValueError:return
        raise AssertionError('Unsafe plan accepted')
    rejected(template)
    ready=copy.deepcopy(template);ready.update(status='ready',transportAuthorized=True,finalFilesApproved=True)
    for i,(name,item) in enumerate(ready['assets'].items()):
        item.update(size=1,sha256='0'*64)
        item['base'].update(id=i*2+1,size=1,sha256='1'*64)
        item['input' if name=='latest-mac.yml' else 'delta'].update(id=i*2+2,name=PREFIX+str(i)+'.input',size=1,sha256='2'*64)
    validate(ready)
    for change in [lambda p:p.update(sourceCommit='0'*40),lambda p:p.update(releaseId=1),lambda p:p['assets'].update({'latest.yml':{}}),lambda p:p['assets'][NAMES[0]]['delta'].update(id=1),lambda p:p['assets'][NAMES[0]]['base'].update(name='../base')]:
        unsafe=copy.deepcopy(ready);change(unsafe);rejected(unsafe)
    with tempfile.TemporaryDirectory(prefix='hg75-delta-selfcheck-') as temp:
        root=Path(temp);base=root/'old';new=root/'new';delta=root/'delta';restored=root/'restored'
        base.write_bytes(b'old transport fixture\n'*4096);new.write_bytes(base.read_bytes()+b'new signed bytes placeholder\n')
        result=subprocess.run(['zstd','-q','--patch-from='+str(base),str(new),'-o',str(delta)],capture_output=True,timeout=30)
        require(result.returncode==0,'Synthetic delta preparation failed')
        restore(base,delta,restored,record(new))
        try:restore(base,delta,root/'wrong',{'size':new.stat().st_size,'sha256':'0'*64})
        except ValueError:pass
        else:raise AssertionError('Incorrect restored SHA accepted')
        for name in NAMES[2:4]:(root/name).write_bytes(name.encode())
        entries=[]
        for name in NAMES[2:4]:entries.append((name,base64.b64encode(hashlib.sha512((root/name).read_bytes()).digest()).decode(),(root/name).stat().st_size))
        text='version: 7.5.0\nfiles:\n'+''.join(f'  - url: {n}\n    sha512: {h}\n    size: {s}\n' for n,h,s in entries)+f'path: {entries[0][0]}\nsha512: {entries[0][1]}\n'
        (root/'latest-mac.yml').write_text(text);check_manifest(root)
    print('PASS local assertions: pending/unsafe plans rejected, exact zstd reconstruction, wrong SHA rejected, both ZIP manifest bindings; no network or media tests')
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--self-check',action='store_true');parser.add_argument('--plan');parser.add_argument('--plan-sha256');parser.add_argument('--execute');parser.add_argument('--check',action='store_true');args=parser.parse_args()
    if args.self_check:self_check();return
    require(args.plan and args.plan_sha256,'Final plan and pinned SHA256 required')
    require(record(Path(args.plan))['sha256']==args.plan_sha256,'Mac plan hash differs from approved input')
    plan=json.loads(Path(args.plan).read_text());validate(plan)
    if args.check:print('PASS final Mac plan assertions; no network or upload');return
    require(args.execute==FROZEN,'Exact frozen source execution required');execute(plan)
if __name__=='__main__':
    try:main()
    except Exception as error:
        receipt['error']=str(error) if type(error) is ValueError else type(error).__name__;save()
        print('Mac transport stopped: '+receipt['error'],file=sys.stderr);sys.exit(1)
