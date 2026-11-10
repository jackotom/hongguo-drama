import React from 'react';
import { User, Settings, Clock, Play, Film, Download } from '../../src/components/icons';

export default function MobileMine({ onNavigate, appInfo }) {
  const links = [
    ['account', '红果账号', '登录与账号观看记录', User],
    ['settings', '设置', '外观、播放与下载偏好', Settings],
    ['history', '观看记录', '本机进度与分组管理', Clock],
    ['calendar', '收藏与上新', '收藏仅保存在本机', Film],
    ['player', '本机剧库', '打开已登记的剧集', Play],
    ['manager', '下载管理', '查看任务和已下载视频', Download],
  ];
  return <section className="mobile-mine">
    <p className="mobile-page-note">自己的片库，接着上次看。</p>
    <div className="mobile-mine-links">{links.map(([id, title, description, Icon]) =>
      <button key={id} onClick={() => onNavigate(id)}><Icon size={23} /><span><strong>{title}</strong><small>{description}</small></span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
    )}</div>
    <details className="mobile-help"><summary>网络与播放说明</summary>
      <p>播放前需准备完整单集，网络、画质和文件大小会影响等待时间。失败时可重试本集，或直接切换在线画质。</p>
      <p>当前使用手机系统网络。来源拒绝、ByteVC2 无兼容片源或单集超过 64MB 时可能无法播放。</p>
    </details>
    <p className="mobile-about">红果 · 自用 {appInfo?.version?.replace(/\.0$/, '')}<br />下载和本机记录保存在此手机；覆盖安装保留，卸载会删除。</p>
  </section>;
}
