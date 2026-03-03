import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import './i18n'

// Intercept fetch to redirect /api to the local Rust backend directly
const originalFetch = window.fetch;
window.fetch = async function (resource, config) {
  if (typeof resource === 'string' && resource.startsWith('/api')) {
    resource = 'http://127.0.0.1:5000' + resource;
  }
  return originalFetch(resource, config);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
