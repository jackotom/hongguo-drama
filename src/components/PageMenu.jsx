import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';

export default function PageMenu({ items, page, onNavigate }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const firstFocus = useRef(0);
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return undefined;
    root.current.querySelectorAll('[role="menuitem"]')[firstFocus.current]?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const show = index => { firstFocus.current = index; setOpen(true); };
  return <div className="toolbar-page-picker" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <button className="toolbar-page-trigger" type="button" ref={trigger} aria-label={t("切换页面")}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'toolbar-page-menu' : undefined}
      title={t(items.find(item => item.id === page)?.label)}
      onClick={() => open ? close() : show(0)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); show(event.key === 'ArrowUp' ? items.length - 1 : 0);
        }
      }}>
      <span>{t(items.find(item => item.id === page)?.label)}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div id="toolbar-page-menu" role="menu" aria-label={t("切换页面")} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
      const index = buttons.indexOf(document.activeElement);
      const next = { ArrowDown: (index + 1) % buttons.length, ArrowUp: (index - 1 + buttons.length) % buttons.length, Home: 0, End: buttons.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); buttons[next].focus(); }
    }}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" tabIndex={-1}
        aria-current={item.id === page ? 'page' : undefined}
        onClick={() => { close(); onNavigate(item.id); }}>{t(item.label)}</button>)}
    </div>}
  </div>;
}
