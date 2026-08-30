import { useClarityPage } from './analytics/clarity'
import { isSsoCallback } from './auth/ssoRedirect'
import { useApiAuth } from './auth/useApiAuth'
import { useClerkUserSync } from './auth/useClerkUserSync'
import { useWalletServerSync } from './auth/useWalletServerSync'
import { AuthBar } from './components/AuthBar'
import { DesktopGate } from './components/DesktopGate'
import { CardPickerPage } from './pages/CardPickerPage'
import { ClaimHandlePage } from './pages/ClaimHandlePage'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProfilePage } from './pages/ProfilePage'
import { RatingRevealPage } from './pages/RatingRevealPage'
import { SsoCallbackPage } from './pages/SsoCallbackPage'
import { VerifyCardsPage } from './pages/VerifyCardsPage'
import type { Route } from './router/hashRouter'
import { useRoute } from './router/useRoute'
import { useAppDispatch, useAppSelector } from './store/hooks'
import { selectCatalogStatus } from './store/selectors'
import { loadCatalog } from './store/catalogSlice'

function renderRoute(route: Route) {
  switch (route.kind) {
    case 'landing':
      return <LandingPage />
    case 'wallet':
      return <CardPickerPage />
    case 'rating':
      return <RatingRevealPage />
    case 'login':
      return <LoginPage />
    case 'verify':
      return <VerifyCardsPage />
    case 'claim':
      return <ClaimHandlePage />
    case 'profile':
      return <ProfilePage username={route.username} />
    case 'notFound':
      return <NotFoundPage />
  }
}

export default function App() {
  const route = useRoute()
  const dispatch = useAppDispatch()
  const catalogStatus = useAppSelector(selectCatalogStatus)

  useEffect(() => {
    if (catalogStatus === 'idle') dispatch(loadCatalog())
  }, [catalogStatus, dispatch])

  useClarityPage(route)

  // Order matters: the API client needs a way to reach the session token before
  // anything tries an authenticated call, and the wallet merge is an
  // authenticated call.
  useApiAuth()
  useClerkUserSync()
  useWalletServerSync()

  // Clerk returns an unfinished Google sign-in to the site root rather than to
  // a hash route, so this is decided on the search string and outranks the
  // route: the hash at that moment is still whatever it was before the trip.
  if (isSsoCallback()) {
    return (
      <DesktopGate>
        <SsoCallbackPage />
      </DesktopGate>
    )
  }

  return (
    <DesktopGate>
      {/* The login screen carries its own sign-in controls, so the floating
          bar would only repeat itself there. */}
      {route.kind !== 'login' && <AuthBar />}
      {renderRoute(route)}
    </DesktopGate>
  )
}
import { useEffect } from 'react'
