import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Supabase auth-js uses `navigator.locks` to serialise token refreshes across
// tabs. Under load (e.g. the Creative Library firing three parallel queries
// while the access token is expiring), the newer refresh attempt "steals" the
// lock and the older one rejects with:
//   AbortError: Lock broken by another request with the 'steal' option
// That error bubbles all the way out of `supabase.from(...).select()` and
// blanks the page with a red banner, even though the request will succeed on
// retry. Replacing the lock with a no-op executor lets concurrent refreshes
// resolve through the JS event-loop queue instead of fighting over a Web Lock.
// Single tab + single session per browser in this app — multi-tab coordination
// isn't doing useful work for us.
const noopLock = async (_name, _acquireTimeout, fn) => fn()

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { lock: noopLock },
})
