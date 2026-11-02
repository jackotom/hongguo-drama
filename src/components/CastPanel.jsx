import React, { useEffect, useRef, useState } from 'react';
export default function CastPanel({ seriesId, episode, title, videoRef }) {
  const [open,setOpen]=useState(false), [devices,setDevices]=useState([]), [busy,setBusy]=useState(false), [error,setError]=useState(''), [target,setTarget]=useState('');
  const operation = useRef(null);
  const cancel = () => {
    const pending = operation.current;
    if (!pending) return;
    pending.cancelled = true;
    if (pending.requestId) void window.electronAPI.releaseOnlinePlay({ requestId: pending.requestId }).catch(() => {});
    if (pending.connecting) void window.electronAPI.controlCasting('Stop').catch(() => {});
  };
  useEffect(() => () => { if (operation.current?.requestId) cancel(); }, [seriesId, episode?.vid]);
  useEffect(() => () => { cancel(); void window.electronAPI.controlCasting('Stop').catch(() => {}); }, []);
  const run = async action => {
    if (operation.current) return;
    const pending = { cancelled: false };
    operation.current = pending;
    setBusy(true); setError('');
    try { await action(pending); }
    catch (e) { if (!pending.cancelled) setError(e.message); }
    finally { if (operation.current === pending) { operation.current = null; setBusy(false); } }
  };
  const check=result=>{if(!result?.success)throw new Error(result?.error || '投屏失败');return result;};
  const scan=()=>run(async pending=>{ const result = check(await window.electronAPI.discoverCastDevices()); if (!pending.cancelled) setDevices(result.devices); });
  const start=id=>run(async pending=>{
    if (!episode || episode.locked) return;
    pending.requestId = crypto.randomUUID();
    let prepared;
    try {
      if (!episode.fileUrl) prepared=check(await window.electronAPI.prepareOnlinePlay({seriesId,vid:episode.vid,vidIndex:episode.vid_index,requestId:pending.requestId,prefetch:true}));
      if (pending.cancelled) return;
      pending.connecting = true;
      const result=check(await window.electronAPI.startCasting({deviceId:id,source:episode.fileUrl || prepared.url,title:`${title} 第${episode.vid_index}集`}));
      if (pending.cancelled) { await window.electronAPI.controlCasting('Stop'); return; }
      setTarget(result.name);videoRef.current?.pause();
    } finally {if(prepared?.streamId)await window.electronAPI.releaseOnlinePlay({streamId:prepared.streamId}).catch(() => {});}
  });
  const control=action=>run(async()=>{check(await window.electronAPI.controlCasting(action));if(action==='Stop')setTarget('');});
  return <div className="cast-panel">
    <button className="btn btn-outline btn-sm" disabled={!episode || episode.locked} onClick={()=>{setOpen(!open);if(!open)scan();}}>投屏{target ? ` · ${target}` : ''}</button>
    {open && <section aria-label="电视投屏" style={{padding:12,border:'1px solid var(--border)',borderRadius:8}}>
      <p>电脑与电视连接同一局域网，电视需开启 DLNA。投屏前会缓存本集；格式支持取决于电视。</p>
      <button className="btn btn-outline btn-sm" disabled={busy} onClick={scan}>{busy?'正在处理…':'重新搜索电视'}</button>
      {!busy && !devices.length && <p>未发现电视，请检查电视的投屏设置和电脑防火墙。</p>}
      {devices.map(device=><button className="btn btn-outline btn-sm" disabled={busy} key={device.id} onClick={()=>start(device.id)}>{device.name}</button>)}
      {busy && <button className="btn btn-outline btn-sm" onClick={cancel}>取消本次操作</button>}
      {target && <div role="group" aria-label="投屏控制">{[['Play','播放'],['Pause','暂停'],['Stop','停止']].map(([action,label])=><button className="btn btn-outline btn-sm" key={action} disabled={busy} onClick={()=>control(action)}>{label}</button>)}</div>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>;
}
