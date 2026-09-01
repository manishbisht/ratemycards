import { useEffect } from 'react'
import { AdminApp } from './admin/AdminApp'
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
import type { AdminRoute, Route } from './router/hashRouter'
import { isAdminRoute } from './router/hashRouter'
import { useRoute } from './router/useRoute'
import { useAppDispatch, useAppSelector } from './store/hooks'
import { selectCatalogStatus } from './store/selectors'
import { loadCatalog } from './store/catalogSlice'

/**
 * The phone screens. Typed against everything *except* the admin routes, which
 * App peels off before calling this -- so the switch is genuinely exhaustive
 * and a new route with no case here is a compile error rather than a component
 * that silently renders nothing.
 */
function renderRoute(route: Exclude<Route, AdminRoute>): React.ReactNode {
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
  const onAdmin = isAdminRoute(route)

  useEffect(() => {
    // The console reads the catalog through its own admin endpoints, so paging
    // the whole thing into the store would be two requests and a localStorage
    // write for nothing.
    if (!onAdmin && catalogStatus === 'idle') dispatch(loadCatalog())
  }, [onAdmin, catalogStatus, dispatch])

  useClarityPage(route)

  // Order matters: the API client needs a way to reach the session token before
  // anything tries an authenticated call, and the wallet merge is an
  // authenticated call. The console needs the first of these as much as the app
  // does, so they run on every route.
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

  // The console is desktop-only and carries its own chrome, so it replaces the
  // page tree rather than mounting inside the phone-only gate.
  if (isAdminRoute(route)) return <AdminApp route={route} />

  return (
    <DesktopGate>
      {/* The login screen carries its own sign-in controls, so the floating
          bar would only repeat itself there. */}
      {route.kind !== 'login' && <AuthBar />}
      {renderRoute(route)}
    </DesktopGate>
  )
}
