import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Component, Suspense, lazy, useState, useCallback } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'

/*
  Lazy import with one-time hot-reload recovery.

  Problem: when Render rebuilds, every JS chunk gets a new content hash
  (e.g. AdsAttributesPage-BypoQopk.js → AdsAttributesPage-Xxxx.js).
  An open browser session has the OLD index.html cached, so React.lazy()
  tries to fetch the old chunk URL — which no longer exists, throwing
  "Failed to fetch dynamically imported module".

  Fix: on a chunk-load failure, reload the page once. The new index.html
  loads with the new chunk hashes, and the user lands on the same route.
  Guard with sessionStorage so we don't loop on a genuine network failure.
*/
const RELOAD_FLAG = 'app:chunk-reload'
function lazyWithReload(factory) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err) {
      const isChunkError = err?.message?.includes('Failed to fetch dynamically imported module')
        || err?.name === 'ChunkLoadError'
      if (isChunkError && !sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
        window.location.reload()
        return new Promise(() => {})  // halt rendering until reload kicks in
      }
      // Already reloaded once OR a non-chunk error — propagate
      throw err
    }
  })
}
// Clear the reload flag once the app has successfully booted (any
// navigation that DOESN'T immediately fail proves we're on a fresh
// bundle). Safe to call eagerly.
if (typeof window !== 'undefined') {
  setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000)
}

// Eager — daily-hit pages. Keeping these in the main bundle avoids a suspense
// flash on every app open, since 90% of sessions land on one of them.
import SalesOverview from './pages/SalesOverview'
import CloserOverview from './pages/CloserOverview'
import SetterOverview from './pages/SetterOverview'
import EODDashboard from './pages/EODDashboard'
import CallData from './pages/CallData'

// Lazy — rarely-visited or heavy. Each becomes its own chunk so they only
// download when the user actually navigates to them. Biggest wins:
// EODReview (3.3k lines) and MarketingPerformance (1.3k lines).
const CloserDetail = lazyWithReload(() => import('./pages/CloserDetail'))
const SetterDetail = lazyWithReload(() => import('./pages/SetterDetail'))
const SetterKPIHistory = lazyWithReload(() => import('./pages/SetterKPIHistory'))
const PipelinePerformance = lazyWithReload(() => import('./pages/PipelinePerformance'))
const MarketingPerformance = lazyWithReload(() => import('./pages/MarketingPerformance'))
const AdsLayout = lazyWithReload(() => import('./pages/ads/AdsLayout'))
const AdsGallery = lazyWithReload(() => import('./pages/ads/AdsGallery'))
const AdsMessaging = lazyWithReload(() => import('./pages/ads/AdsMessaging'))
const AdsList = lazyWithReload(() => import('./pages/ads/AdsList'))
const AdsHooks = lazyWithReload(() => import('./pages/ads/AdsHooks'))
const AdsBodies = lazyWithReload(() => import('./pages/ads/AdsBodies'))
const AdsScenes = lazyWithReload(() => import('./pages/ads/AdsScenes'))
const AdsCreators = lazyWithReload(() => import('./pages/ads/AdsCreators'))
const AdsVariants = lazyWithReload(() => import('./pages/ads/AdsVariants'))
const AdsClips = lazyWithReload(() => import('./pages/ads/AdsClips'))
const AdsPerformance = lazyWithReload(() => import('./pages/ads/AdsPerformance'))
const AdsCreativeTestingLayout = lazyWithReload(() => import('./pages/ads/AdsCreativeTestingLayout'))
const AdsInsights = lazyWithReload(() => import('./pages/ads/AdsInsights'))
const AdsCreativesLibrary = lazyWithReload(() => import('./pages/ads/AdsCreativesLibrary'))
const AdsCreativeLibrary = lazyWithReload(() => import('./pages/ads/AdsCreativeLibrary'))
const EditorView = lazyWithReload(() => import('./pages/ads/EditorView'))
const EditorLogin = lazyWithReload(() => import('./pages/ads/EditorLogin'))
const AdsAttributesPage = lazyWithReload(() => import('./pages/ads/AdsAttributesPage'))
const AdsExplorations = lazyWithReload(() => import('./pages/ads/AdsExplorations'))
const AdsTestScope = lazyWithReload(() => import('./pages/ads/AdsTestScope'))
const AdsGenerator = lazyWithReload(() => import('./pages/ads/AdsGenerator'))
const AdsOrphans = lazyWithReload(() => import('./pages/ads/AdsOrphans'))
const AdsLegacy = lazyWithReload(() => import('./pages/ads/AdsLegacy'))
const ComponentDetail = lazyWithReload(() => import('./pages/ads/ComponentDetail'))
const VariantDetail = lazyWithReload(() => import('./pages/ads/VariantDetail'))
const AdDetail = lazyWithReload(() => import('./pages/ads/AdDetail'))
const EODReview = lazyWithReload(() => import('./pages/EODReview'))
const SettingsPage = lazyWithReload(() => import('./pages/SettingsPage'))
const CommissionPage = lazyWithReload(() => import('./pages/CommissionPage'))
const CommissionDetail = lazyWithReload(() => import('./pages/CommissionDetail'))
const SetterBot = lazyWithReload(() => import('./pages/SetterBot'))
const EmailFlows = lazyWithReload(() => import('./pages/EmailFlows'))
const EmailFlowDetail = lazyWithReload(() => import('./pages/EmailFlowDetail'))

import SetPasswordPage from './pages/SetPasswordPage'
import SplashScreen from './components/SplashScreen'
import { Loader } from 'lucide-react'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  hardReload = () => {
    // Bypass cache via a cache-busting query param. Cheaper than asking
    // the user to remember Ctrl+Shift+R.
    const u = new URL(window.location.href)
    u.searchParams.set('_r', Date.now())
    window.location.replace(u.toString())
  }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, fontFamily: 'monospace', maxWidth: 920, margin: '0 auto' }}>
        <h2 style={{ color: '#b53e3e' }}>Runtime Error</h2>
        <p style={{ fontFamily: 'system-ui, sans-serif', color: '#333', lineHeight: 1.5 }}>
          Often this is a stale browser cache after a deploy. Try a hard reload first.
        </p>
        <button onClick={this.hardReload} style={{
          marginTop: 8, marginBottom: 24, padding: '10px 18px',
          fontFamily: 'system-ui, sans-serif', fontSize: 13, fontWeight: 600,
          background: '#0a0a0a', color: '#fff', border: 'none', cursor: 'pointer',
        }}>Hard reload</button>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#b53e3e' }}>{this.state.error.message}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#999', fontSize: 12 }}>{this.state.error.stack}</pre>
      </div>
    )
    return this.props.children
  }
}

// Shape-matching fallback for lazy routes so the layout doesn't jump while
// a chunk downloads. Uses the existing design-system skeleton classes.
function PageSkeleton() {
  return (
    <div className="space-y-4 animate-pulse max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between">
        <div className="h-7 w-48 bg-bg-card rounded-sm" />
        <div className="h-8 w-40 bg-bg-card rounded-sm" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <div key={i} className="tile tile-feedback h-24" />)}
      </div>
      <div className="tile tile-feedback h-96" />
    </div>
  )
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading, needsPasswordSetup } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <Loader className="animate-spin text-text-primary" size={32} />
      </div>
    )
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (needsPasswordSetup) return <SetPasswordPage />
  return children
}

function AdminRoute({ children }) {
  const { isAdmin } = useAuth()
  if (!isAdmin) return <Navigate to="/sales" replace />
  return children
}

export default function App() {
  const [splashDone, setSplashDone] = useState(() => sessionStorage.getItem('splash_shown') === '1')

  const handleSplashComplete = useCallback(() => {
    sessionStorage.setItem('splash_shown', '1')
    setSplashDone(true)
  }, [])

  return (
    <ErrorBoundary>
      <AuthProvider>
        {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* Editor portal — magic-link login + auth-gated view. The
                /editor-view/:token route still works during rollout so
                already-shared share-links don't break; once every editor
                has logged in with their email, the token route gets
                removed and the cutover is complete. */}
            <Route path="/editor-login" element={<Suspense fallback={<PageSkeleton />}><EditorLogin /></Suspense>} />
            <Route path="/editor-view" element={<Suspense fallback={<PageSkeleton />}><EditorView /></Suspense>} />
            <Route path="/editor-view/:token" element={<Suspense fallback={<PageSkeleton />}><EditorView /></Suspense>} />
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route path="/" element={<Navigate to="/sales" replace />} />
              <Route path="/sales" element={<SalesOverview />} />
              <Route path="/sales/closers" element={<CloserOverview />} />
              <Route path="/sales/closers/:id" element={<Suspense fallback={<PageSkeleton />}><CloserDetail /></Suspense>} />
              <Route path="/sales/setters" element={<SetterOverview />} />
              <Route path="/sales/setters/:id" element={<Suspense fallback={<PageSkeleton />}><SetterDetail /></Suspense>} />
              <Route path="/sales/setters/:id/kpi-history" element={<Suspense fallback={<PageSkeleton />}><SetterKPIHistory /></Suspense>} />
              <Route path="/sales/pipeline" element={<Suspense fallback={<PageSkeleton />}><PipelinePerformance /></Suspense>} />
              <Route path="/sales/marketing" element={<Suspense fallback={<PageSkeleton />}><MarketingPerformance /></Suspense>} />
              <Route path="/sales/ads" element={<Suspense fallback={<PageSkeleton />}><AdsLayout /></Suspense>}>
                <Route index element={<Navigate to="/sales/ads/performance" replace />} />
                <Route path="performance" element={<Suspense fallback={<PageSkeleton />}><AdsPerformance /></Suspense>} />
                <Route path="messaging" element={<Suspense fallback={<PageSkeleton />}><AdsMessaging /></Suspense>} />

                {/* Creative testing — wrapper with sub-nav for Clips · Variants · Ads */}
                <Route path="creative" element={<Suspense fallback={<PageSkeleton />}><AdsCreativeTestingLayout /></Suspense>}>
                  <Route index element={<Navigate to="/sales/ads/creative/insights" replace />} />
                  <Route path="clips" element={<Suspense fallback={<PageSkeleton />}><AdsClips /></Suspense>} />
                  <Route path="variants" element={<Suspense fallback={<PageSkeleton />}><AdsVariants /></Suspense>} />
                  <Route path="ads" element={<Suspense fallback={<PageSkeleton />}><AdsList /></Suspense>} />
                  <Route path="insights" element={<Suspense fallback={<PageSkeleton />}><AdsInsights /></Suspense>} />
                  <Route path="creatives" element={<Suspense fallback={<PageSkeleton />}><AdsCreativesLibrary /></Suspense>} />
                  <Route path="library" element={<Suspense fallback={<PageSkeleton />}><AdsCreativeLibrary /></Suspense>} />
                  <Route path="attributes" element={<Suspense fallback={<PageSkeleton />}><AdsAttributesPage /></Suspense>} />
                  <Route path="explorations" element={<Suspense fallback={<PageSkeleton />}><AdsExplorations /></Suspense>} />
                  <Route path="tests" element={<Suspense fallback={<PageSkeleton />}><AdsTestScope /></Suspense>} />
                  <Route path="generate" element={<Suspense fallback={<PageSkeleton />}><AdsGenerator /></Suspense>} />
                </Route>

                {/* Back-compat redirects for old direct URLs */}
                <Route path="clips" element={<Navigate to="/sales/ads/creative/clips" replace />} />
                <Route path="variants" element={<Navigate to="/sales/ads/creative/variants" replace />} />
                <Route path="list" element={<Navigate to="/sales/ads/creative/ads" replace />} />
                <Route path="hooks" element={<Navigate to="/sales/ads/creative" replace />} />
                <Route path="bodies" element={<Navigate to="/sales/ads/creative" replace />} />
                <Route path="scenes" element={<Navigate to="/sales/ads/creative" replace />} />
                <Route path="creators" element={<Navigate to="/sales/ads/creative" replace />} />

                {/* Detail pages — independent of the sub-nav */}
                <Route path="variants/:variantId" element={<Suspense fallback={<PageSkeleton />}><VariantDetail /></Suspense>} />
                <Route path="components/:id" element={<Suspense fallback={<PageSkeleton />}><ComponentDetail /></Suspense>} />
                <Route path="orphans" element={<Suspense fallback={<PageSkeleton />}><AdsOrphans /></Suspense>} />
                <Route path="legacy" element={<Suspense fallback={<PageSkeleton />}><AdsLegacy /></Suspense>} />
                <Route path="ad/:id" element={<Suspense fallback={<PageSkeleton />}><AdDetail /></Suspense>} />
              </Route>
              <Route path="/sales/eod" element={<EODDashboard />} />
              <Route path="/sales/eod/submit" element={<Suspense fallback={<PageSkeleton />}><EODReview /></Suspense>} />
              <Route path="/sales/eod-history" element={<Navigate to="/sales/eod" replace />} />
              <Route path="/sales/call-data" element={<CallData />} />
              <Route path="/sales/commissions" element={<Suspense fallback={<PageSkeleton />}><CommissionPage /></Suspense>} />
              <Route path="/sales/commissions/:id" element={<Suspense fallback={<PageSkeleton />}><CommissionDetail /></Suspense>} />
              <Route path="/sales/setter-bot" element={<Suspense fallback={<PageSkeleton />}><SetterBot /></Suspense>} />
              <Route path="/sales/email-flows" element={<Suspense fallback={<PageSkeleton />}><EmailFlows /></Suspense>} />
              <Route path="/sales/email-flows/:flowId" element={<Suspense fallback={<PageSkeleton />}><EmailFlowDetail /></Suspense>} />
              <Route path="/sales/settings" element={<AdminRoute><Suspense fallback={<PageSkeleton />}><SettingsPage /></Suspense></AdminRoute>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
