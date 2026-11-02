import React, { useEffect, useId, useState } from 'react';
import { readLocalLibrary, saveLocalSeries, subscribeLocalLibrary, publicDateKey } from '../localLibrary';
import './CommunityPanel.css';

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN') : '暂无数据';
const reviewDate = value => {
  if (!value) return '';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
};

export default function CommunityPanel({ seriesId, episodeId, title, cover, children, trailingAction }) {
  const id = String(seriesId || '');
  const panelId = useId();
  const [openedSeries, setOpenedSeries] = useState('');
  const opened = !!id && openedSeries === id;
  const [scope, setScope] = useState('series');
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [library, setLibrary] = useState(readLocalLibrary);
  const requestKey = `${id}:${episodeId || ''}:${retry}`;
  const detail = result?.key === requestKey ? result.data : null;
  const favorite = library.items.some(item => item.id === id && item.favorite);
  const currentEpisodeId = String(episodeId || '');
  const likedEpisodeIds = library.items.find(item => item.id === id)?.liked_episode_ids || [];
  const episodeLiked = !!currentEpisodeId && likedEpisodeIds.includes(currentEpisodeId);

  useEffect(() => subscribeLocalLibrary(setLibrary), []);
  useEffect(() => { setScope('series'); }, [id]);
  useEffect(() => {
    if (!opened) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        if (!window.electronAPI?.getPublicDetails) throw new Error('当前环境暂不支持读取公开剧评');
        const data = await window.electronAPI.getPublicDetails(id, episodeId || undefined);
        if (!data?.success) throw new Error(data?.error || '公开剧评暂时无法加载');
        if (cancelled) return;
        setResult({ key: requestKey, data });
        setLibrary(saveLocalSeries({ id, title, cover, published_at: data.published_at }));
      } catch (failure) {
        if (!cancelled) setError(failure.message || '公开剧评暂时无法加载');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opened, id, episodeId, title, cover, requestKey]);

  if (!id) return null;
  const episodeScope = scope === 'episode' && !!episodeId;
  const reviews = episodeScope ? detail?.episode_reviews : detail?.reviews;
  const items = Array.isArray(reviews?.items) ? reviews.items.filter(item => item && typeof item.content === 'string') : [];
  const publishedDate = publicDateKey(detail?.published_at);
  const emptyText = episodeScope
    ? reviews ? '本次未返回公开评论。' : '当前来源暂未提供单集评论。'
    : reviews ? '本次未返回公开评论。' : '当前来源暂未提供整剧剧评。';
  const partialText = reviews?.total != null && reviews.total > items.length
    ? `本次展示 ${items.length} 条公开评论，公开总数 ${count(reviews.total)}；更多评论可在红果 App 查看。`
    : `本次展示 ${items.length} 条公开评论；更多评论可在红果 App 查看。`;

  return <section className="community-panel" aria-label="公开剧评与本机收藏">
    <div className="community-heading">
      <div><h3>剧评与收藏</h3><p>公开评论，只读。收藏仅保存在本机。</p></div>
      <div className="community-actions">
        {children}
        <button type="button" className="btn btn-outline" onClick={async () => {
          try {
            await navigator.clipboard.writeText(`https://hongguoduanju.com/detail?series_id=${encodeURIComponent(id)}`);
            setShareStatus('官方分享链接已复制');
          } catch { setShareStatus('复制失败，请重试'); }
        }}>复制分享链接</button>
        <button type="button" className={`btn ${favorite ? 'community-favorited' : 'btn-outline'}`} aria-pressed={favorite} onClick={() => setLibrary(saveLocalSeries({ id, title, cover, favorite: !favorite }))}>{favorite ? '已收藏到本机' : '收藏到本机'}</button>
        <button type="button" className={`btn community-episode-like ${episodeLiked ? 'community-favorited' : 'btn-outline'}`} aria-pressed={episodeLiked} disabled={!episodeId} onClick={() => {
          if (!currentEpisodeId) return;
          const next = episodeLiked ? likedEpisodeIds.filter(value => value !== currentEpisodeId) : [...likedEpisodeIds, currentEpisodeId];
          setLibrary(saveLocalSeries({ id, title, cover, liked_episode_ids: next }));
        }}><span className="community-heart" aria-hidden="true">{episodeLiked ? '♥' : '♡'}</span>{episodeLiked ? '已点小红心（本机）' : '本集小红心（本机）'}</button>
        {episodeId && <button type="button" className="btn btn-outline community-episode-button" aria-expanded={opened && episodeScope} aria-controls={panelId} onClick={() => {
          if (opened && episodeScope) setOpenedSeries('');
          else { setScope('episode'); setOpenedSeries(id); }
        }}>{opened && episodeScope ? '收起当前集评论' : '当前集评论'}</button>}
        <button type="button" className="btn btn-outline" aria-expanded={opened && !episodeScope} aria-controls={panelId} onClick={() => {
          if (opened && !episodeScope) setOpenedSeries('');
          else { setScope('series'); setOpenedSeries(id); }
        }}>{opened && !episodeScope ? '收起剧评' : '查看公开剧评'}</button>
        {trailingAction && <div className="community-action-trailing">{trailingAction}</div>}
      </div>
    </div>
    {library.error && <p className="community-error" role="alert">{library.error}</p>}
    {shareStatus && <p className="community-note" role="status">{shareStatus}</p>}
    {opened && <div id={panelId} className="community-content" aria-busy={loading}>
      {loading && <p className="community-status" role="status">正在读取公开评分与评论…</p>}
      {!loading && error && <div className="community-error" role="alert"><p>{error}</p><button type="button" className="btn btn-sm" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {!loading && !error && detail && <>
        <dl className="community-metrics">
          <div><dt>公开评分</dt><dd>{count(detail.rating)}</dd></div>
          <div><dt>评分人数</dt><dd>{count(detail.rating_count)}</dd></div>
          <div><dt>公开点赞</dt><dd>{count(detail.like_count)}</dd></div>
          <div><dt>公开收藏</dt><dd>{count(detail.favorite_count)}</dd></div>
        </dl>
        {publishedDate && <p className="community-date">首次公开：{publishedDate}（北京时间）</p>}
        <div className="community-review-heading">
          <div className="community-switch" role="group" aria-label="评论范围">
            <button type="button" aria-pressed={!episodeScope} onClick={() => setScope('series')}>整剧剧评</button>
            <button type="button" aria-pressed={episodeScope} disabled={!episodeId} onClick={() => setScope('episode')}>当前集评论</button>
          </div>
          <span>{reviews?.total != null ? `公开总数 ${count(reviews.total)} · ` : ''}本次返回 {items.length} 条</span>
        </div>
        {items.length ? <ul className="community-reviews">{items.map((review, index) => <li key={`${review.created_at || ''}:${index}`}>
          <div className="community-review-meta"><strong>{typeof review.author === 'string' && review.author.trim() ? review.author : '公开用户'}</strong><span>{reviewDate(review.created_at)}</span></div>
          <p>{review.content}</p>
          <div className="community-review-foot">{review.rating != null && <span>评分 {count(review.rating)}</span>}{review.likes != null && <span>公开点赞 {count(review.likes)}</span>}</div>
        </li>)}</ul> : <p className="community-status">{emptyText}</p>}
        {items.length > 0 && <p className="community-note">{partialText}</p>}
      </>}
    </div>}
  </section>;
}
