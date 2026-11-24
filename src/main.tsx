import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getRuntimePlatform, isDesktopApp } from './platform';
import './styles/global.css';
import './styles/prism.css';
import './styles/pop.css';
import './styles/desktop.css';

if (isDesktopApp()) {
  document.documentElement.dataset.runtime = 'desktop';
  document.documentElement.dataset.platform = getRuntimePlatform();
}

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
