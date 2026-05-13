import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { readDashboardTheme } from './storage/dashboardTheme';

if (readDashboardTheme() === 'dark') {
  document.documentElement.setAttribute('data-dashboard-theme', 'dark');
  document.documentElement.style.colorScheme = 'dark';
}

if (window.meetingAssistant?.overlayWindow) {
  document.documentElement.classList.add('openwhispr-dashboard-window');
  document.body.classList.add('openwhispr-dashboard-window');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
