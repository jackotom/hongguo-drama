#!/usr/bin/env python3
"""Five-file draft-only transport, reusing release-7.2-cloud.py provenance/digest guards."""
from pathlib import Path, PurePosixPath
import argparse, base64, hashlib, json, os, re, stat, subprocess, sys, zipfile
REPO='jackotom/hongguo-drama'
FROZEN='4ffff289d6dd289e589a0fd0e65aa7aa5c2a7567'
DRAFT,RUN,ARTIFACT=446852363,43872907869,14229555967
ARCHIVE={'size':405939287,'sha256':'87f0a23eca60774396488dd44d4f1c8574b2cd6287060ba8e81d7e7211c40b9c'}
NAMES=['hongguo-downloader-7.5-win-x64-setup.exe','hongguo-downloader-7.5-win-x64-setup.exe.blockmap','hongguo-downloader-7.5-win-x64.exe','hongguo-downloader-7.5-win-x64.zip','latest.yml']
RESULT=Path('transport-result.json')
receipt={'releaseId':DRAFT,'sourceCommit':FROZEN,'version':'7.5.0','buildVersion':'7.5.2','runId':RUN,'artifactId':ARTIFACT,'transportCommit':os.environ.get('GITHUB_SHA'),'passed':False,'verified':[]}
def require(value,message):
    if not value: raise ValueError(message)
def record(path):
    require(path.is_file() and not path.is_symlink(),'Physical input required')
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return {'size':path.stat().st_size,'sha256':h.hexdigest()}
def api(route,destination=None):
    command=['gh','api','repos/'+REPO+'/'+route]
    if destination is not None:
        with destination.open('xb') as output:r=subprocess.run(command,stdout=output,stderr=subprocess.PIPE,timeout=300)
        require(r.returncode==0,'GitHub binary download failed')
        return
    r=subprocess.run(command,capture_output=True,timeout=60)
    require(r.returncode==0,'GitHub metadata read failed')
    return json.loads(r.stdout)
def draft():
    x=api('releases/'+str(DRAFT))
    require(x.get('id')==DRAFT and x.get('draft') is True and x.get('prerelease') is False and x.get('published_at') is None and x.get('tag_name')=='v7.5' and x.get('target_commitish')==FROZEN,'Exact draft/source binding changed')
    return x
def rows():
    result=[]
    for page in range(1,5):
        batch=api(f'releases/{DRAFT}/assets?per_page=100&page={page}');result+=batch
        if len(batch)<100:
            require(len(result)==len({r['name'] for r in result}),'Duplicate remote names')
            return {r['name']:r for r in result}
    raise ValueError('Unexpected draft inventory size')
def matches(row,expected):
    return bool(row) and row.get('state')=='uploaded' and row.get('size')==expected['size'] and row.get('digest')=='sha256:'+expected['sha256']
def save():RESULT.write_text(json.dumps(receipt,indent=2)+'\n')
def reconcile():
    x=draft();current=rows();receipt['draftStillUnpublished']=x['draft'] and x['published_at'] is None
    receipt['remoteReadback']=[{k:current[n].get(k) for k in ('name','id','state','size','digest')} if n in current else {'name':n,'missing':True} for n in NAMES]
    save();return current
def validate(plan):
    require(plan.get('sourceCommit')==FROZEN and plan.get('version')=='7.5.0' and plan.get('buildVersion')=='7.5.2','Wrong candidate')
    require(plan.get('releaseId')==DRAFT and plan.get('tag')=='v7.5' and plan.get('transportAuthorized') is True,'Wrong authorized draft')
    require(plan.get('runId')==RUN and plan.get('runAttempt')==1 and plan.get('artifactId')==ARTIFACT and plan.get('artifactName')=='windows-release-candidate' and plan.get('archive')==ARCHIVE,'Wrong run/artifact/archive binding')
    require(set(plan.get('assets',{}))==set(NAMES) and len(NAMES)==5,'Only five Windows files authorized')
    for x in plan['assets'].values():
        require(type(x.get('size')) is int and x['size']>0 and re.fullmatch('[0-9a-f]{64}',x.get('sha256','')),'Invalid file binding')
        old=x.get('replace')
        require(old is None or (set(old)=={'id','state','size','digest'} and type(old['id']) is int and old['id']>0),'Invalid replacement binding')
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',required=True);parser.add_argument('--plan-sha256',required=True)
    parser.add_argument('--execute');parser.add_argument('--check',action='store_true');args=parser.parse_args()
    require(record(Path(args.plan))['sha256']==args.plan_sha256,'Plan digest changed')
    plan=json.loads(Path(args.plan).read_text());validate(plan)
    if args.check:
        print('PASS local plan assertions; no network or application execution');return
    require(args.execute==FROZEN and os.environ.get('GITHUB_REF')=='refs/heads/codex/transport-7.5','Exact source/dedicated branch required')
    reconcile()
    run=api('actions/runs/'+str(RUN))
    require(run.get('id')==RUN and run.get('head_sha')==FROZEN and run.get('run_attempt')==1 and run.get('event')=='workflow_dispatch' and run.get('path')=='.github/workflows/windows.yml' and run.get('status')=='completed' and run.get('conclusion')=='success','Successful frozen Windows provenance changed')
    a=api('actions/artifacts/'+str(ARTIFACT))
    require(a.get('id')==ARTIFACT and a.get('name')==plan['artifactName'] and a.get('expired') is False and a.get('size_in_bytes')==ARCHIVE['size'] and a.get('digest')=='sha256:'+ARCHIVE['sha256'] and a.get('workflow_run',{}).get('id')==RUN and a.get('workflow_run',{}).get('head_sha')==FROZEN,'Original artifact identity/size/digest changed')
    work=Path('transport');work.mkdir(exist_ok=False);archive=work/'windows-original.zip'
    api(f'actions/artifacts/{ARTIFACT}/zip',archive)
    require(record(archive)==ARCHIVE,'Downloaded archive digest changed')
    with zipfile.ZipFile(archive) as source:
        names=source.namelist()
        require(len(names)==len(set(names)) and all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts and '\\' not in n for n in names),'Unsafe or duplicate ZIP paths')
        identity=source.getinfo('SOURCE-SHA.txt')
        require(identity.file_size<128 and source.read(identity).decode('utf-8-sig').strip()==FROZEN,'Artifact SOURCE-SHA changed')
        for name in NAMES:
            info=source.getinfo(name);expected=plan['assets'][name]
            require(not info.is_dir() and not stat.S_ISLNK(info.external_attr>>16) and info.file_size==expected['size'],'Wrong selected ZIP member type/size')
            with source.open(info) as origin,(work/name).open('xb') as output:
                for block in iter(lambda:origin.read(1024*1024),b''):output.write(block)
            require(record(work/name)=={k:expected[k] for k in ('size','sha256')},'Selected file digest changed: '+name)
    with zipfile.ZipFile(work/NAMES[3]) as portable:
        require(portable.namelist()==[NAMES[2]] and hashlib.sha256(portable.read(NAMES[2])).hexdigest()==plan['assets'][NAMES[2]]['sha256'],'Portable ZIP/EXE mismatch')
    sha512=base64.b64encode(hashlib.sha512((work/NAMES[0]).read_bytes()).digest()).decode();manifest=(work/'latest.yml').read_text()
    require(re.findall(r'^version:\s*(\S+)\s*$',manifest,re.M)==['7.5.0'] and re.findall(r'^\s*(?:-\s*)?url:\s*(\S+)\s*$',manifest,re.M)==[NAMES[0]] and re.findall(r'^path:\s*(\S+)\s*$',manifest,re.M)==[NAMES[0]] and re.findall(r'^\s*sha512:\s*(\S+)\s*$',manifest,re.M)==[sha512,sha512] and re.findall(r'^\s*size:\s*(\d+)\s*$',manifest,re.M)==[str(plan['assets'][NAMES[0]]['size'])],'Update manifest does not bind exact setup')
    receipt['originalCiZipBindingVerified']=True;save()
    for name in NAMES:
        current=reconcile();expected=plan['assets'][name];row=current.get(name)
        if not matches(row,expected):
            require(row is None or {k:row.get(k) for k in ('id','state','size','digest')}==expected['replace'],'Unexpected conflicting Windows asset preserved: '+name)
            command=['gh','release','upload','v7.5','--repo',REPO,str(work/name)]
            if row is not None:command.append('--clobber')
            receipt['inFlight']=name;save()
            try:
                process=subprocess.run(command,capture_output=True,timeout=300);success=process.returncode==0
            except subprocess.TimeoutExpired:success=False
            current=reconcile()
            require(matches(current.get(name),expected),'Upload incomplete after reconciliation: '+name)
            receipt['clientReportedSuccess']=success
        item=current[name];receipt['verified'].append({'name':name,'id':item['id'],'size':item['size'],'sha256':expected['sha256']});receipt.pop('inFlight',None);save()
        print('VERIFIED '+name,flush=True)
    final=reconcile();require(all(matches(final.get(n),plan['assets'][n]) for n in NAMES),'Final five-file readback failed')
    receipt['passed']=True;save();print('PASS five Windows draft assets; no publication, tag or other asset changes')
if __name__=='__main__':
    try:main()
    except Exception as error:
        receipt['error']=str(error) if type(error) is ValueError else type(error).__name__;save()
        print('Transport stopped: '+receipt['error'],file=sys.stderr);sys.exit(1)
