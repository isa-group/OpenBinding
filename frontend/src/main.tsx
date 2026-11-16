// First, and deliberately: styles/tailwind.css opens with the cascade layer statement, and a layer takes its place from
// where its name is first seen, so it has to be the first stylesheet the application loads.
import './styles/tailwind.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyBrand, initialBrand } from './modules/core/theme/brand'

// Before the first paint, so the page never flashes the other palette.
applyBrand(initialBrand())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
