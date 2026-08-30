import { DesktopGate } from './components/DesktopGate'
import { CardPickerPage } from './pages/CardPickerPage'
import { ClaimHandlePage } from './pages/ClaimHandlePage'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProfilePage } from './pages/ProfilePage'
import { RatingRevealPage } from './pages/RatingRevealPage'
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

  return <DesktopGate>{renderRoute(route)}</DesktopGate>
}
import { useEffect } from 'react'
