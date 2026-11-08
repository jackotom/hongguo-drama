import { t, useLanguage } from '../i18n';
import React, { useEffect, useMemo, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import './ReleaseCalendar.css';

export default function ReleaseCalendar({ onPlay, opening = '', active = true }) {
  useLanguage();
  const [library, setLibrary] = useState(readLocalLibrary);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [chosenMonth, setChosenMonth] = useState('');
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());
  useEffect(() => subscribeLocalLibrary(setLibrary), []);
  useEffect(() => {
    if (!library.items.some(item => !item.cover) || !window.electronAPI?.getSeriesList) return;
    let cancelled = false;
    window.electronAPI.getSeriesList().then(items => {
      if (!cancelled && Array.isArray(items)) setCatalogCovers(new Map(items.map(item => [String(item.series_id), item.cover || ''])));
    }).catch(() => {}); // Missing local metadata leaves the poster placeholder available.
    return () => { cancelled = true; };
  }, []);
  const rows = useMemo(() => library.items.map(item => ({ ...item, cover: item.cover || catalogCovers.get(item.id) || '', date: publicDateKey(item.published_at) })), [library.items, catalogCovers]);
  const dated = rows.filter(item => item.date).sort((a, b) => b.date.localeCompare(a.date));
  const filtered = rows.filter(item => !favoritesOnly || item.favorite);
  const months = [...new Set(filtered.filter(item => item.date).map(item => item.date.slice(0, 7)))].sort().reverse();
  const month = months.includes(chosenMonth) ? chosenMonth : months[0] || '';
  const monthItems = filtered.filter(item => item.date.startsWith(`${month}-`)).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'));
  const days = [...new Set(monthItems.map(item => item.date))];
  const undated = filtered.filter(item => !item.date);
  const favoritesCount = rows.filter(item => item.favorite).length;
  const row = item => <li key={item.id} className="release-row">
    <div className="release-poster" aria-hidden="true"><span>{t("暂无海报")}</span>{item.cover && <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</div>
    <div className="release-title"><strong>{item.title}</strong><span>{t(item.date ? `首次公开 ${item.date}` : '暂无首次公开时间')}</span></div>
    <div className="release-row-actions">
      <button type="button" className="btn btn-sm btn-outline" aria-label={t(`${item.favorite ? '取消收藏' : '收藏'}《${item.title}》`)} aria-pressed={item.favorite} onClick={() => setLibrary(saveLocalSeries({ id: item.id, title: item.title, favorite: !item.favorite }))}>{t(item.favorite ? '已收藏' : '收藏')}</button>
      <button type="button" className="btn btn-sm btn-outline" aria-label={t(`移除《${item.title}》`)} title={t("仅移除本机收藏与日历记录，不删除视频文件")} onClick={() => setLibrary(removeLocalSeries(item.id))}>{t("移除")}</button>
      <button type="button" className="btn btn-sm" disabled={!onPlay || !!opening || !active} aria-label={t(`播放《${item.title}》`)} onClick={() => onPlay?.({ seriesId: item.id, title: item.title })}>{t(opening === item.id ? '打开中…' : '播放')}</button>
    </div>
  </li>;

  return <section className="release-calendar">
    <header><h2>{t("上新日历")}</h2><p className="page-description">{t("已浏览剧集的首次公开日历。打开剧集的「公开剧评」后，真实日期会保存在这里。")}</p></header>
    <p className="release-coverage">{t("本机收录 ")}{t(rows.length)}{t(" 部 · 有公开日期 ")}{t(dated.length)}{t(" 部")}{t(dated.length > 0 ? ` · ${dated[dated.length - 1].date} 至 ${dated[0].date}` : '')}{t("。按北京时间显示，不是完整上新排期。")}</p>
    {library.error && <div className="release-error" role="alert"><p>{t(library.error)}</p><button type="button" className="btn btn-sm" onClick={() => setLibrary(readLocalLibrary())}>{t("重新读取")}</button></div>}
    <div className="release-toolbar">
      <div className="release-filter" role="group" aria-label={t("日历范围")}><button type="button" aria-pressed={!favoritesOnly} onClick={() => setFavoritesOnly(false)}>{t("全部已浏览")}</button><button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(true)}>{t("本机收藏 ")}{t(favoritesCount)}</button></div>
      {months.length > 0 && <label className="release-month">{t("月份")}<select value={month} onChange={event => setChosenMonth(event.target.value)}>{months.map(value => <option key={value} value={value}>{t(value.slice(0, 4))}{t(" 年 ")}{t(Number(value.slice(5)))}{t(" 月")}</option>)}</select></label>}
    </div>
    {!library.error && !filtered.length && <div className="release-empty"><h3>{t(favoritesOnly ? '还没有本机收藏' : '还没有可展示的剧集')}</h3><p>{t("前往「发现短剧」打开官方短剧，展开「公开剧评」读取首次公开日期；也可以点「收藏到本机」，留待下次观看。")}</p></div>}
    {days.map(day => <section className="release-day" key={day} aria-label={t(`${day} 首次公开`)}><h3><span>{t(Number(day.slice(8)))}</span><small>{t(Number(day.slice(5, 7)))}{t(" 月")}</small></h3><ul>{monthItems.filter(item => item.date === day).map(row)}</ul></section>)}
    {undated.length > 0 && <section className="release-undated"><h3>{t("公开日期待提供 ")}<span>{t(undated.length)}{t(" 部")}</span></h3><p>{t("这些剧集已保存在本机，但服务尚未返回首次公开日期。")}</p><ul>{undated.map(row)}</ul></section>}
  </section>;
}
