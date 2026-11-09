import { t, useLanguage } from './i18n';
// 红果短剧：版本及发行状态见 package.json 和 docs/release-6.4.md。
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Film, Download, Settings, Play, Home, Search, Clock, User } from './components/icons';
import HongguoDownload from './components/HongguoDownload';
import DownloadManager from './components/DownloadManager';
import SettingsPage from './components/Settings';
import Player from './components/Player';
import Browse from './components/Browse';
import PageMenu from './components/PageMenu';
import WatchHistory from './components/WatchHistory';
import { initializeTheme } from './theme';
import useStealthWindow from './components/useStealthWindow';
import './components/StealthWindow.css';
import AppUpdateNotice from './components/AppUpdateNotice';
import AnnouncementNotice from './components/AnnouncementNotice';
import DramaFeed from './components/DramaFeed';
import ReleaseCalendar from './components/ReleaseCalendar';
import AccountManagement from './components/AccountManagement';

const MENU = [
  { id: 'browse', label: '发现短剧', icon: Home },
  { id: 'feed', label: '热播推荐', icon: Film },
  { id: 'download', label: '搜索与下载', icon: Search },
  { id: 'player', label: '我的剧库', icon: Play },
  { id: 'history', label: '观看记录', icon: Clock },
  { id: 'calendar', label: '收藏与上新', icon: Clock },
  { id: 'manager', label: '下载管理', icon: Download },
  { id: 'account', label: '红果账号', icon: User },
  { id: 'settings', label: '设置', icon: Settings },
];

export default function App({ platformPages = {} }) {
  useLanguage();
  const mobile = window.electronAPI.platform === 'android';
  const [moreOpen, setMoreOpen] = useState(false);
  const navigationHistory = useRef(['browse']);
  const backNavigation = useRef(false);
  useEffect(() => { if (mobile) console.info('HG:shared-react:ready'); }, [mobile]);
  const { stealthMode, toggleStealth, stealthError } = useStealthWindow();
  const [wakeRegionFocus, setWakeRegionFocus] = useState(0);
  const [wakeSettingsOpening, setWakeSettingsOpening] = useState(false);
  useLayoutEffect(() => initializeTheme(), []);
  const [layout, setLayout] = useState('landscape');
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [actionsHidden, setActionsHidden] = useState(false);
  const [borderless, setBorderless] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const layoutLock = useRef(false);
  const [page, setPage] = useState('browse');
  const pageRef = useRef('browse');
  const calendarRequest = useRef(0);
  const calendarOpeningRef = useRef(false);
  const [calendarOpening, setCalendarOpening] = useState('');
  const [visited, setVisited] = useState(['browse']);
  const [storageError, setStorageError] = useState('');
  const [appInfo, setAppInfo] = useState(null); // { version, brand, appName }
  const [playerMounted, setPlayerMounted] = useState(false);
  const floatingPlayer = useRef(false);
  const setFloatingPlayer = useCallback(value => { floatingPlayer.current = value; }, []);
  const [playerTarget, setPlayerTarget] = useState(null); // 浏览页点播 -> 播放页选中
  const rememberPlayerSeries = useCallback((seriesId) => {
    // 保留命令时间戳避免重复初始化；重新挂载时只按当前系列的最新断点恢复。
    setPlayerTarget(target => ({ seriesId, resume: true, autoplay: false, ts: target?.ts }));
  }, []);

  useEffect(() => {
    window.electronAPI.getWindowLayout?.().then(setLayout);
    window.electronAPI.getAlwaysOnTop?.().then(setAlwaysOnTop);
    window.electronAPI.getAppInfo().then((info) => {
      setAppInfo(info);
    });
  }, []);

  useEffect(() => window.electronAPI.onStorageError?.((data) => {
    setStorageError(data === null ? '' : data?.error || '数据保存失败，请检查磁盘空间和目录权限后重试。');
  }), []);

  // 主进程发来的导航指令（例如浏览页点「立即播放」）
  useEffect(() => {
    if (!window.electronAPI.onNavigate) return undefined;
    return window.electronAPI.onNavigate((data) => {
      if (!data || !data.page) return;
      if (data.payload) setPlayerTarget({ ...data.payload, ts: Date.now() });
      navigate(data.page);
    });
  }, []);

  const navigate = (nextPage) => {
    setMoreOpen(false);
    if (mobile && nextPage !== pageRef.current) {
      if (!backNavigation.current) navigationHistory.current.push(nextPage);
      backNavigation.current = false;
    }
    if (nextPage !== pageRef.current) {
      calendarRequest.current++;
      calendarOpeningRef.current = false;
      setCalendarOpening('');
      pageRef.current = nextPage;
    }
    if (nextPage === 'player' || (nextPage === 'feed' && !floatingPlayer.current)) setPlayerMounted(nextPage === 'player');
    setVisited((pages) => pages.includes(nextPage) ? pages : [...pages, nextPage]);
    setPage(nextPage);
  };

  useEffect(() => {
    if (!mobile) return;
    window.appBack = () => {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
      if (moreOpen) { setMoreOpen(false); return true; }
      if (episodesOpen) { setEpisodesOpen(false); return true; }
      if ([...document.querySelectorAll('[role="dialog"], .browse-drawer, .proxy-modal, .player-confirm')].some(element => element.getClientRects().length)) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;
      }
      if (navigationHistory.current.length > 1) {
        navigationHistory.current.pop(); backNavigation.current = true;
        navigate(navigationHistory.current.at(-1)); return true;
      }
      return false;
    };
    return () => { delete window.appBack; };
  }, [mobile, moreOpen, episodesOpen]);

  const renderPage = (id) => {
    switch (id) {
      case 'browse':
        return <Browse active={page === id} onNavigate={navigate} />;
      case 'player':
        return playerMounted ? <Player portrait={layout === 'portrait'} episodesOpen={episodesOpen} setEpisodesOpen={setEpisodesOpen} actionsHidden={actionsHidden || (borderless && layout === 'portrait')} active={page === id} target={playerTarget} onSeriesSelected={rememberPlayerSeries} onFloatingChange={setFloatingPlayer} onNavigate={navigate} /> : null;
      case 'feed':
        return page === 'feed' ? <DramaFeed onNavigate={navigate} /> : null;
      case 'calendar':
        return <ReleaseCalendar opening={calendarOpening} active={page === id} onPlay={async ({ seriesId }) => {
          if (pageRef.current !== 'calendar' || calendarOpeningRef.current) return;
          const version = ++calendarRequest.current;
          calendarOpeningRef.current = true;
          setCalendarOpening(seriesId);
          try {
            const payload = { seriesId, resume: true };
            let result = await window.electronAPI.playSeries(payload);
            if (version !== calendarRequest.current) return;
            if (!result?.success && result?.code === 'SERIES_NOT_FOUND') {
              const resolved = await window.electronAPI.searchResolve(seriesId);
              if (version !== calendarRequest.current) return;
              if (!resolved?.success) throw new Error(resolved?.error || '加载剧集失败，请重试');
              result = await window.electronAPI.playSeries(payload);
            }
            if (!result?.success) throw new Error(result?.error || '打开播放失败，请重试');
          } catch (error) {
            if (version === calendarRequest.current) setStorageError(error.message);
          } finally {
            if (version === calendarRequest.current) { calendarOpeningRef.current = false; setCalendarOpening(''); }
          }
        }} />;
      case 'history':
        return <WatchHistory active={page === id} onNavigate={navigate} />;
      case 'account':
        return <AccountManagement active={page === id} />;
      case 'manager':
        return <DownloadManager active={page === id} onNavigate={navigate} />;
      case 'settings':
        if (platformPages.settings) return React.createElement(platformPages.settings, { active: page === id, appInfo });
        return <SettingsPage active={page === id} preview={appInfo?.preview} appInfo={appInfo} wakeRegionFocus={wakeRegionFocus} />;
      case 'download':
      default:
        return <HongguoDownload active={page === id} onNavigate={navigate} />;
    }
  };

  const toggleLayout = async () => {
    if (layoutLock.current) return;
    layoutLock.current = true;
    setLayoutBusy(true);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      const mode = layout === 'portrait' ? 'landscape' : 'portrait';
      const result = await window.electronAPI.setWindowLayout(mode);
      if (!result.success) throw new Error(result.error);
      setLayout(result.mode);
    } catch (error) {
      setStorageError(error.message || '切换失败，请重试。');
    } finally {
      layoutLock.current = false;
      setLayoutBusy(false);
    }
  };

  const isMac = appInfo?.platform === 'darwin' || (!appInfo?.platform && /Mac/.test(navigator.platform));
  const currentPage = MENU.find((item) => item.id === page);

  return (
    <div className={`app-layout ${mobile ? 'platform-android' : ''} ${stealthMode ? 'stealth-mode' : ''} ${isMac ? 'platform-mac' : ''} layout-${layout} ${page === 'player' ? 'player-focused' : ''} ${borderless && page === 'player' && layout === 'portrait' ? 'player-borderless' : ''}`}>
      <aside className="sidebar" aria-label={t("主导航")}>
        <div className="sidebar-window-drag" aria-hidden="true" />
        <div className="sidebar-brand">
          <div className="logo"><Play size={21} /></div>
          <div><div className="brand-text">{t(appInfo?.appName || '红果短剧')}</div><div className="brand-sub">{t(appInfo?.preview ? '独立体验 · 本机保存' : '每一集，都值得期待')}</div></div>
        </div>
        <nav className="sidebar-menu">
          <div className="sidebar-group-label">{t("内容")}</div>
          {MENU.filter((item) => item.id !== 'settings').map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`sidebar-item ${page === item.id ? 'active' : ''}`}
                aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
                <Icon size={19} /><span>{t(item.label)}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button className={`sidebar-item ${page === 'settings' ? 'active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}>
            <Settings size={19} /><span>{t("设置")}</span>
          </button>
          <div className="footer-note"><span>{t(appInfo?.preview ? '功能预览' : '红果短剧')}</span><span>{t(appInfo?.version ? `v${appInfo.version.replace(/^(\d+\.\d+)\.0$/, '$1')}` : '')}</span></div>
        </div>
      </aside>
      <div className="main-wrapper">
        <header className="window-toolbar">
          {mobile ? <><button className="mobile-back btn btn-outline btn-sm" aria-label={t("返回上一页")} onClick={() => window.appBack?.()}>{t("返回")}</button><h1 className="toolbar-location">{t(currentPage?.label)}</h1></> : <span className="toolbar-location">{t(currentPage?.label)}</span>}
          {page === 'player' && layout === 'portrait' && <PageMenu items={MENU} page={page} onNavigate={navigate} />}
          <div className="toolbar-actions">
            <span className="toolbar-caption">{t(appInfo?.preview ? '功能预览' : '红果短剧')}</span>
            {!mobile && page === 'player' && <button className="btn btn-outline btn-sm" onClick={() => { setEpisodesOpen(false); toggleStealth(true); }} title={t("小窗置顶播放并在支持的系统上跨虚拟桌面可见；鼠标移开时暂停隐藏，移回继续；Esc 退出")}>{t("小窗模式")}</button>}
            {!mobile && page === 'player' && layout === 'portrait' && <button className="btn btn-outline btn-sm portrait-episodes-toggle" aria-expanded={episodesOpen}
              aria-controls="player-episode-panel" onClick={() => setEpisodesOpen(open => !open)}>{t(episodesOpen ? '收起选集' : '选集')}</button>}
            {page === 'player' && <button className="btn btn-outline btn-sm player-actions-toggle" aria-pressed={actionsHidden || borderless && layout === 'portrait'}
              onClick={() => {
                if (borderless && layout === 'portrait') { setBorderless(false); setActionsHidden(false); }
                else setActionsHidden(hidden => !hidden);
              }}>{t(actionsHidden || borderless && layout === 'portrait' ? '显示按钮' : '隐藏按钮')}</button>}
            {page === 'player' && layout === 'portrait' && <button className="btn btn-outline btn-sm borderless-toggle" aria-pressed={borderless}
              onClick={() => setBorderless(value => !value)}>{t(borderless ? '恢复边框' : '去掉边框')}</button>}
            <button className="btn btn-outline btn-sm pin-toggle" aria-pressed={alwaysOnTop} disabled={pinBusy}
              aria-label={t(alwaysOnTop ? '取消置顶' : '置顶')} title={t(alwaysOnTop ? '取消置顶' : '置顶')}
              onClick={async () => {
                setPinBusy(true);
                try { setAlwaysOnTop(await window.electronAPI.setAlwaysOnTop(!alwaysOnTop)); }
                catch { setStorageError('置顶切换失败，请重试。'); }
                finally { setPinBusy(false); }
              }}><svg width="17" height="17" viewBox="0 0 24 24" fill={alwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 6 4 4v2H5v-2l4-4-1-6Z" /><path d="M12 15v6" /></svg></button>
            <button className="btn btn-outline btn-sm layout-toggle" onClick={toggleLayout}
              disabled={layoutBusy} aria-pressed={layout === 'portrait'}
              aria-label={t(layout === 'portrait' ? '切换横屏版' : '切换竖屏版')}
              title={t(layout === 'portrait' ? '恢复横屏窗口与布局' : '切换竖屏窗口，放大竖屏视频')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                {layout === 'portrait' ? <rect x="3" y="6" width="18" height="12" rx="2" /> : <rect x="6" y="3" width="12" height="18" rx="2" />}
              </svg>
              {t(layoutBusy ? '切换中…' : layout === 'portrait' ? '横屏版' : '竖屏版')}
            </button>
          </div>
        </header>
        <nav className="compact-navigation" aria-label={t("竖屏导航")}>
          {MENU.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} aria-current={page === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)} title={t(item.label)}><Icon size={18} /><span>{t(item.label)}</span></button>;
          })}
        </nav>
        {!mobile && !appInfo?.preview && <AppUpdateNotice />}
        {!mobile && !appInfo?.preview && <AnnouncementNotice />}
        {stealthMode && <div className="stealth-toolbar"><span>{t("移开暂停隐藏 · 移回继续")}</span><div className="stealth-toolbar-actions">
          <button className="btn btn-outline btn-sm" disabled={wakeSettingsOpening} onClick={async () => {
            if (wakeSettingsOpening) return;
            setWakeSettingsOpening(true);
            try {
              const result = await window.electronAPI.setStealthMode(false);
              if (!result?.success) throw new Error(result?.error || '小窗切换失败，请重试');
              setWakeRegionFocus(value => value + 1);
              navigate('settings');
            } catch (error) { setStorageError(error.message || '小窗切换失败，请重试'); }
            finally { setWakeSettingsOpening(false); }
          }}>{t('设置唤醒区域')}</button>
          <button className="btn btn-outline btn-sm" disabled={wakeSettingsOpening} onClick={() => toggleStealth(false)}>{t("退出小窗")}</button>
        </div></div>}
        {stealthError && <div className="app-storage-error" role="alert">{t(stealthError)}</div>}
        {storageError && <div className="app-storage-error" role="alert"><span>{t(storageError)}</span><button className="btn btn-outline btn-sm" onClick={() => setStorageError('')}>{t("关闭提示")}</button></div>}
        {visited.map((id) => <main className="main-content" data-page={id} hidden={page !== id} key={id}>{t(renderPage(id))}</main>)}
        {mobile && <nav className="mobile-navigation" aria-label={t("手机主导航")}>
          {MENU.filter(item => ['browse','download','player','history'].includes(item.id)).map(item => {
            const Icon = item.icon;
            return <button key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon size={21} /><span>{t(({ browse: '发现', download: '搜索', player: '剧库', history: '记录' })[item.id])}</span></button>;
          })}
          <button aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><Settings size={21} /><span>{t("更多")}</span></button>
        </nav>}
        {mobile && moreOpen && <div className="mobile-more-mask" onClick={() => setMoreOpen(false)}><section className="mobile-more" role="dialog" aria-modal="true" aria-label={t("更多功能")} onClick={event => event.stopPropagation()}>
          <h2>{t("更多功能")}</h2>
          {MENU.filter(item => !['browse','download','player','history'].includes(item.id)).map(item => {
            const Icon = item.icon; return <button key={item.id} onClick={() => navigate(item.id)}><Icon size={21} /><span>{t(item.label)}</span></button>;
          })}
          <button className="btn btn-outline" onClick={() => setMoreOpen(false)}>{t("关闭")}</button>
        </section></div>}
      </div>
    </div>
  );
}
