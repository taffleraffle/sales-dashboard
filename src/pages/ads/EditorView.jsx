import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import AdsCreativeLibrary from './AdsCreativeLibrary'

/*
  /editor-view/:token — public, no-login surface for editors to see
  their tasks, the creative library, and update task status.

  Permissions threaded through:
    canDelete:       false  — editor can't delete creatives
    canUpload:       false  — editor can't add new creatives
    canEditCreative: false  — editor can't change canonical_name/type/etc
    canEditTask:     true   — editor can update status/notes/due
    canAssignTask:   true   — only for self-assign from unassigned pile
    canDeleteTask:   false  — editor can't delete tasks
    defaultEditorFilter: editor.id (if token bound to an editor)
*/

export default function EditorView() {
  const { token } = useParams()
  const [link, setLink] = useState(null)
  const [editor, setEditor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let mounted = true
    const init = async () => {
      const { data: linkData, error: linkErr } = await supabase
        .from('lib_editor_share_links')
        .select('*, editor:lib_creative_editors(*)')
        .eq('token', token)
        .is('revoked_at', null)
        .maybeSingle()
      if (!mounted) return
      if (linkErr || !linkData) {
        setErr('Invalid or revoked share link')
        setLoading(false)
        return
      }
      setLink(linkData)
      setEditor(linkData.editor || null)
      setLoading(false)
      // Touch last_used_at (fire and forget)
      supabase.from('lib_editor_share_links')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', linkData.id)
        .then(() => {})
    }
    init()
    return () => { mounted = false }
  }, [token])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--paper)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
      }}>Loading…</div>
    )
  }

  if (err) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--paper)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 40,
      }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10,
          }}>Access denied</div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500,
            color: 'var(--ink)', marginBottom: 12,
          }}>{err}</h1>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-3)' }}>
            Ask whoever shared this link to send you a fresh one, or to check that it hasn't been revoked.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)' }}>
      {/* Editor view header — replaces the normal dashboard chrome */}
      <header style={{
        padding: '14px 32px', borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>OPT Digital · Editor portal</div>
          <h1 style={{
            margin: '4px 0 0', fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500,
            color: 'var(--ink)',
          }}>
            {editor ? `${editor.name}'s queue` : 'Creative library'}
          </h1>
        </div>
        {editor && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', background: 'white', border: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 11,
          }}>
            <span style={{
              width: 9, height: 9, borderRadius: 2,
              background: '#3e7eba',  /* placeholder; matches the hash */
            }} />
            <span style={{ color: 'var(--ink-3)' }}>Logged in as</span>
            <span style={{ fontWeight: 600 }}>{editor.name}</span>
          </div>
        )}
      </header>

      {/* Wrapper — main content uses the existing AdsCreativeLibrary with
          a permissions object so it knows to lock down the admin-only bits */}
      <div style={{
        maxWidth: 1400, margin: '0 auto', padding: '0 32px',
      }}>
        <AdsCreativeLibrary editorScope={{
          isEditorView: true,
          editorId: editor?.id || null,
          editorName: editor?.name || null,
          canDelete: false,
          canUpload: false,
          canEditCreative: false,
          canEditTask: true,
          canAssignSelf: true,
          canDeleteTask: false,
          canManageEditors: false,
        }} />
      </div>
    </div>
  )
}
