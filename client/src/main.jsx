import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(<App />)

// Register the service worker so the app is installable to the phone home screen
// (Add to Home Screen → opens standalone). Dev (Vite on :5173) has no sw.js, so
// only register where it exists; failures are non-fatal.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
