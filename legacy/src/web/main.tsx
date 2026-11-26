import '@x-tech-laboratories/halon/halon-tokens.css';
import '@x-tech-laboratories/halon/halon.css';
import './app.css';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';

createRoot(document.getElementById('app')!).render(<App />);
