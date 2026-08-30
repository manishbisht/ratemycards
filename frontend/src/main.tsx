import { ClerkProvider } from '@clerk/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import App from './App.tsx'
import { initClarity } from './analytics/clarity.ts'
import { normalizeSsoReturn } from './auth/ssoRedirect.ts'
import { normalizeInitialHash } from './router/hashRouter.ts'
import { store } from './store/store.ts'
import './styles/tokens.css'
import './styles/base.css'

// Before the hash is normalized, because a finished Google round trip lands on
// the bare root and this is what redirects it to the step it was headed for.
normalizeSsoReturn()

// Runs before the first render so the landing screen does not leave a second
// history entry behind the user's first Back press.
normalizeInitialHash()

// After the hash is normalized, so the session's first recorded URL is `#/`
// rather than whichever bare form the visitor happened to arrive on.
initClarity()

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// The product is dark-only, so Clerk's modals get the app's tokens rather than
// its default light chrome. Values are literals because Clerk renders into a
// portal that CSS custom properties on :root still reach, but its own theming
// takes plain colors.
const clerkAppearance = {
  variables: {
    colorBackground: '#12121a',
    colorText: '#ffffff',
    colorTextSecondary: 'rgba(255,255,255,0.62)',
    colorPrimary: '#ffffff',
    colorDanger: '#f87171',
    colorSuccess: '#34d399',
    fontFamily: "'Outfit', system-ui, -apple-system, 'Segoe UI', sans-serif",
    borderRadius: '14px',
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      appearance={clerkAppearance}
      afterSignOutUrl="/"
    >
      <Provider store={store}>
        <App />
      </Provider>
    </ClerkProvider>
  </StrictMode>,
)