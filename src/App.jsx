import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Component, useState, useCallback } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import SalesOverview from './pages/SalesOverview'
import CloserOverview from './pages/CloserOverview'
import CloserDetail from './pages/CloserDetail'
import SetterOverview from './pages/SetterOverview'
import SetterDetail from './pages/SetterDetail'
import EODReview from './pages/EODReview'
import MarketingPerformance from './pages/MarketingPerformance'
import CallData from './pages/CallData'
import SettingsPage from './pages/SettingsPage'
import CommissionPage from './pages/CommissionPage'
import CommissionDetail from './pages/CommissionDetail'
import SetterBot from './pages/SetterBot'
import SetterKPIHistory from './pages/SetterKPIHistory'
// EODHistory is now embedded in EODReview page
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
              <Route path="/sales/closers/:id" element={<CloserDetail />} />
              <Route path="/sales/setters" element={<SetterOverview />} />
              <Route path="/sales/setters/:id" element={<SetterDetail />} />
              <Route path="/sales/setters/:id/kpi-history" element={<SetterKPIHistory />} />
              <Route path="/sales/marketing" element={<MarketingPerformance />} />
              <Route path="/sales/eod" element={<EODReview />} />
              <Route path="/sales/eod-history" element={<Navigate to="/sales/eod" replace />} />
              <Route path="/sales/call-data" element={<CallData />} />
              <Route path="/sales/commissions" element={<CommissionPage />} />
              <Route path="/sales/commissions/:id" element={<CommissionDetail />} />
              <Route path="/sales/setter-bot" element={<SetterBot />} />
              <Route path="/sales/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
