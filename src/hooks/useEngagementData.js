import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

export function useEngagementData(days = 30) {
  const [conversations, setConversations] = useState([])
  const [messages, setMessages] = useState([])
  const [setters, setSetters] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      const since = sinceDate(days)

      const [convosRes, msgsRes, settersRes] = await Promise.all([
        supabase
          .from('engagement_conversations')
          .select('*')
          .gte('created_at', since)
          .order('created_at', { ascending: false }),
        supabase
          .from('engagement_messages')
          .select('id, conversation_id, direction, sent_at')
          .gte('sent_at', since),
        supabase
          .from('engagement_setters')
          .select('*')
          .eq('active', true),
      ])

      if (convosRes.error) console.error('engagement_conversations:', convosRes.error)
      if (msgsRes.error) console.error('engagement_messages:', msgsRes.error)
      if (settersRes.error) console.error('engagement_setters:', settersRes.error)

      setConversations(convosRes.data || [])
      setMessages(msgsRes.data || [])
      setSetters(settersRes.data || [])
      setLoading(false)
    }
    fetch()
  }, [days])

  // Computed stats
  const convos = conversations
  const total = convos.length
  const active = convos.filter(c => c.status === 'active').length
  const completed = convos.filter(c => c.status === 'completed').length
  const handedOff = convos.filter(c => c.status === 'handed_off').length
  const stopped = convos.filter(c => c.status === 'stopped').length
  const withReply = convos.filter(c => c.last_prospect_reply_at).length
  const replyRate = total > 0 ? ((withReply / total) * 100).toFixed(1) : '0'
  const booked = convos.filter(c => c.booking_state === 'confirmed').length
  const bookingRate = total > 0 ? ((booked / total) * 100).toFixed(1) : '0'

  const outbound = messages.filter(m => m.direction === 'outbound').length
  const inbound = messages.filter(m => m.direction === 'inbound').length

  // By sequence type
  const bySequence = {}
  convos.forEach(c => {
    const seq = c.sequence_type || 'unknown'
    bySequence[seq] = (bySequence[seq] || 0) + 1
  })

  // Per-setter stats
  const setterStats = setters.map(s => {
    const setterConvos = convos.filter(c => c.setter_id === s.id)
    const setterReplied = setterConvos.filter(c => c.last_prospect_reply_at).length
    const setterTotal = setterConvos.length
    return {
      ...s,
      convos: setterTotal,
      replies: setterReplied,
      replyRate: setterTotal > 0 ? ((setterReplied / setterTotal) * 100).toFixed(1) : '0',
      booked: setterConvos.filter(c => c.booking_state === 'confirmed').length,
      handedOff: setterConvos.filter(c => c.status === 'handed_off').length,
    }
  })

  // Recent activity (last 20)
  const recentActivity = convos.slice(0, 20).map(c => {
    const lastMsg = (c.messages || []).slice(-1)[0]
    return {
      ...c,
      lastMessage: lastMsg?.content || '',
      lastDirection: lastMsg?.direction || '',
      lastTime: lastMsg?.time || c.updated_at,
    }
  })

  return {
    conversations: convos,
    loading,
    stats: {
      total,
      active,
      completed,
      handedOff,
      stopped,
      withReply,
      replyRate,
      booked,
      bookingRate,
      outbound,
      inbound,
      bySequence,
    },
    setterStats,
    recentActivity,
    setters,
  }
}
