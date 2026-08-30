import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import App from './App.tsx'
import { normalizeInitialHash } from './router/hashRouter.ts'
import { store } from './store/store.ts'
import './styles/tokens.css'
import './styles/base.css'

// Runs before the first render so the landing screen does not leave a second
// history entry behind the user's first Back press.
normalizeInitialHash()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
)
