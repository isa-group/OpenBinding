// First, and deliberately: this declares the cascade layer order, and a layer
// takes its place from where its name is first seen. See styles/layers.css.
import './styles/layers.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
