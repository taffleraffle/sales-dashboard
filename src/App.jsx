import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import SalesOverview from './pages/SalesOverview'
import MarketingPerformance from './pages/MarketingPerformance'
import CloserOverview from './pages/CloserOverview'
import CloserDetail from './pages/CloserDetail'
import SetterOverview from './pages/SetterOverview'
import SetterDetail from './pages/SetterDetail'
import LeadAttribution from './pages/LeadAttribution'
import EODReview from './pages/EODReview'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/sales" replace />} />
          <Route path="/sales" element={<SalesOverview />} />
          <Route path="/sales/marketing" element={<MarketingPerformance />} />
          <Route path="/sales/closers" element={<CloserOverview />} />
          <Route path="/sales/closers/:id" element={<CloserDetail />} />
          <Route path="/sales/setters" element={<SetterOverview />} />
          <Route path="/sales/setters/:id" element={<SetterDetail />} />
          <Route path="/sales/attribution" element={<LeadAttribution />} />
          <Route path="/sales/eod" element={<EODReview />} />
          <Route path="/sales/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
