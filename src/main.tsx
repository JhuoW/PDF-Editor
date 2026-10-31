import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { EditorErrorBoundary } from './components/Feedback/EditorErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorErrorBoundary><App /></EditorErrorBoundary>
  </StrictMode>,
)
