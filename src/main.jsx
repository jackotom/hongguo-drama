// 红果短剧 8.4 正式版：界面入口；发行记录与验证范围见 docs/release-8.4.md。
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import { initializePosterSize } from './theme';

import { initializeLanguage } from './i18n';

initializePosterSize();


initializeLanguage().then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
));
