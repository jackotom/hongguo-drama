import './bridge.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx';
import MobileSettings from './settings.jsx';
import MobileMine from './mine.jsx';
import { initializePosterSize } from '../../src/theme.js';
import '../../src/index.css';
import './mobile.css';
import './mobile-shell.css';
import './mobile-library.css';
import './mobile-player.css';

if (!localStorage.getItem('hongguo.catalog.channel.v1')) localStorage.setItem('hongguo.catalog.channel.v1', 'web');
initializePosterSize();
createRoot(document.getElementById('root')).render(<ErrorBoundary><App platformPages={{ settings: MobileSettings, mine: MobileMine }} /></ErrorBoundary>);
console.info('HG:shared-react:started');
