import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './Admin.css'
import Admin from './Admin.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
)
