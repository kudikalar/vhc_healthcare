import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import App from './App.jsx';
import { AppProviders } from './modules.js';
import '@fontsource-variable/instrument-sans/wdth.css';
import '@fontsource/noto-sans-devanagari/400.css';
import '@fontsource/noto-sans-devanagari/600.css';
import '@fontsource/noto-sans-telugu/400.css';
import '@fontsource/noto-sans-telugu/600.css';
import './styles.css';
import './polish.css'; // design layer: imported last so it refines every page's styles

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AppProviders>
          <App />
        </AppProviders>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
