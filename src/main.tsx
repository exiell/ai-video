import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/prism.css';
import './styles/pop.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
