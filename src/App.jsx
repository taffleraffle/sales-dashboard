import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Component, Suspense, lazy, useState, useCallback } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'

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
const CloserDetail = lazy(() => import('./pages/CloserDetail'))
const SetterDetail = lazy(() => import('./pages/SetterDetail'))
const SetterKPIHistory = lazy(() => import('./pages/SetterKPIHistory'))
const PipelinePerformance = lazy(() => import('./pages/PipelinePerformance'))
const MarketingPerformance = lazy(() => import('./pages/MarketingPerformance'))
const EODReview = lazy(() => import('./pages/EODReview'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const CommissionPage = lazy(() => import('./pages/CommissionPage'))
const CommissionDetail = lazy(() => import('./pages/CommissionDetail'))
const SetterBot = lazy(() => import('./pages/SetterBot'))
const EmailFlows = lazy(() => import('./pages/EmailFlows'))
const EmailFlowDetail = lazy(() => import('./pages/EmailFlowDetail'))

import SetPasswordPage from './pages/SetPasswordPage'
import SplashScreen from './components/SplashScreen'
import { Loader } from 'lucide-react'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, color: '#ff6b6b', fontFamily: 'monospace' }}>
        <h2>Runtime Error</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
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
        <div className="h-7 w-48 bg-bg-card rounded-xl" />
        <div className="h-8 w-40 bg-bg-card rounded-xl" />
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
        <Loader className="animate-spin text-opt-yellow" size={32} />
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
