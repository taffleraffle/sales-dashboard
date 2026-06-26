/*
  Editor-management + task-creation modals, extracted from
  AdsCreativeLibrary.jsx (library split 5/5, 2026-06-13). Pure UI +
  their own supabase writes; zero submission/review code (verified).
  sendEditorInvite is module-private (only these modals called it).
*/
import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../../../lib/supabase'
import Modal from '../../../components/editorial/Modal'
import {
  Field, TYPES, EDITOR_COLORS, editorColor, rowDisplayName, SUPABASE_URL,
  inputStyle, selectStyle, primaryBtn, ghostBtn, chipLabelStyle,
} from './shared'
import {
  uploadWithResume, captureVideoThumbnail, captureVideoThumbnailFromUrl,
} from './upload'

/* Small badges for editor format (shorts / long / both) and tier
   (admin / editor). Used in the Manage Editors roster + anywhere else
   we want to show at a glance which editors do what. */
export function FormatBadge({ format }) {
  const f = format || 'both'
  const label = f === 'shorts' ? 'Shorts' : f === 'long' ? 'Long' : 'Both'
  const color = f === 'shorts' ? '#7a4eb3' : f === 'long' ? '#0f7a8c' : 'var(--ink-3)'
  const bg    = f === 'shorts' ? 'rgba(122,78,179,0.10)' : f === 'long' ? 'rgba(15,122,140,0.10)' : 'var(--paper-2)'
  return (
    <span style={{
      padding: '2px 8px', display: 'inline-block',
      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color, background: bg, border: `1px solid ${color}`, borderRadius: 2,
    }}>{label}</span>
  )
}
export function TierBadge({ tier }) {
  const t = tier || 'editor'
  const isAdmin = t === 'admin'
  return (
    <span style={{
      padding: '2px 8px', display: 'inline-block',
      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color: isAdmin ? '#a8650f' : 'var(--ink-3)',
      background: isAdmin ? '#fffaea' : 'var(--paper-2)',
      border: `1px solid ${isAdmin ? '#d09c08' : 'var(--rule)'}`,
      borderRadius: 2,
    }}>{isAdmin ? 'Admin' : 'Editor'}</span>
  )
}

/* Dedicated Manage Editors modal — centralized roster view + add new +
   row-level edit click-through. */


/* Best-effort editor invite. Fires the invite-editor Edge Function which
   emails the new editor an OPT-branded welcome pointing at /editor-login.
   Call AFTER the lib_creative_editors row is inserted (the function only
   mails addresses on the active roster). Returns:
     'sent'    - Resend accepted the email
     'failed'  - function errored / roster lookup missed / Resend rejected
     'skipped' - no email supplied (editor can be invited later)
   Never throws — the row already exists; the email is a nudge the editor
   can self-serve at /editor-login if it doesn't land. */
export async function sendEditorInvite(email, name) {
  if (!email) return 'skipped'
  try {
    const { data, error } = await supabase.functions.invoke('invite-editor', {
      body: { email, name: name || '' },
    })
    if (error) return 'failed'
    return data?.sent ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

export function ManageEditorsModal({ editors, tasks, selfEditorId, onClose, onEditorAdded, onEditorPatched, onEditorsRemoved, onOpenEditor }) {
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [addStatus, setAddStatus] = useState(null)  // { color, text } after a quick-add
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // Self-lockout guard: a coordinator managing the roster from the portal
  // (selfEditorId set) can't select / delete / deactivate their own row.
  // Ben on the dashboard has selfEditorId=null so no row is protected.
  const isSelf = (id) => selfEditorId != null && id === selfEditorId
  const toggleSel = (id) => {
    if (isSelf(id)) return
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(editors.filter(e => !isSelf(e.id)).map(e => e.id)))
  const clearSel = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    setBusy(true); setErr(null)
    const ids = Array.from(selectedIds).filter(id => !isSelf(id))
    const { error } = await supabase.from('lib_creative_editors')
      .delete().in('id', ids)
    setBusy(false)
    if (error) setErr(error.message)
    else { setSelectedIds(new Set()); setConfirmBulkDelete(false); onEditorsRemoved?.(ids) }
  }

  // Task counts per editor (active + overall)
  const counts = useMemo(() => {
    const m = {}
    for (const t of tasks) {
      const id = t.editor_id || '__unassigned'
      if (!m[id]) m[id] = { open: 0, done: 0 }
      if (t.status === 'done') m[id].done++
      else m[id].open++
    }
    return m
  }, [tasks])

  const addEditor = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr(null); setAddStatus(null)
    const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const cleanEmail = newEmail.trim() ? newEmail.trim().toLowerCase() : null
    const { data, error } = await supabase.from('lib_creative_editors')
      .insert({ name: newName.trim(), slug, email: cleanEmail })
      .select()
      .single()
    if (error) { setBusy(false); setErr(error.message); return }
    // Auto-send the welcome invite (best-effort) so the new editor knows
    // to log in. Row exists now → the function's roster guard finds it.
    const inviteStatus = await sendEditorInvite(cleanEmail, newName.trim())
    setBusy(false)
    const added = newName.trim()
    setNewName(''); setNewEmail('')
    if (data) onEditorAdded?.(data)
    setAddStatus(
      inviteStatus === 'sent'    ? { color: '#3e8a5e', text: `Added ${added} · invite emailed to ${cleanEmail}` }
      : inviteStatus === 'skipped' ? { color: 'var(--ink-3)', text: `Added ${added} · no email, so no invite sent (add one via the row to enable login)` }
      :                            { color: '#a8650f', text: `Added ${added} · invite email didn't send — they can still log in at /editor-login` }
    )
  }

  const toggleActive = async (e) => {
    if (isSelf(e.id)) return  // can't deactivate yourself
    const next = !e.active
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: next }).eq('id', e.id)
    if (error) setErr(error.message)
    else onEditorPatched?.(e.id, { active: next })
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="Settings"
      title="Manage editors"
      subtitle="Roster of editors. Add new ones, set their format + tier, deactivate inactive ones, click any row to edit details + share links."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Add new editor — name + email so the invite can go out. */}
        <div style={{
          padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
          display: 'grid', gap: 8,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={chipLabelStyle}>Add new</span>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
              placeholder="Editor name (e.g. Sarah)"
              style={{ ...inputStyle, flex: 1 }} />
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
              placeholder="email (sends invite)"
              style={{ ...inputStyle, flex: 1 }} />
            <button onClick={addEditor} disabled={!newName.trim() || busy} style={primaryBtn}>
              {busy ? '…' : '+ Add + invite'}
            </button>
          </div>
          {addStatus && (
            <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: addStatus.color, lineHeight: 1.4 }}>
              {addStatus.text}
            </div>
          )}
        </div>

        {/* Bulk selection bar — sticky when any editor is selected */}
        {selectedIds.size > 0 && (
          <div style={{
            padding: '10px 14px', background: 'var(--ink)', color: 'var(--paper)',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em' }}>
              {selectedIds.size} SELECTED
            </span>
            <button onClick={selectAll} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all ({editors.length})</button>
            <button onClick={clearSel} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
            <span style={{ flex: 1 }} />
            {confirmBulkDelete ? (
              <>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ffb4b4' }}>
                  Delete {selectedIds.size} editor{selectedIds.size === 1 ? '' : 's'} forever? Their tasks become Unassigned.
                </span>
                <button onClick={() => setConfirmBulkDelete(false)} disabled={busy} style={{
                  padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--paper)',
                  border: '1px solid rgba(255,255,255,0.5)', cursor: 'pointer',
                }}>Cancel</button>
                <button onClick={bulkDelete} disabled={busy} style={{
                  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: '#b53e3e', color: 'var(--paper)', border: 'none', cursor: 'pointer',
                }}>{busy ? 'Deleting…' : 'Delete forever'}</button>
              </>
            ) : (
              <button onClick={() => setConfirmBulkDelete(true)} style={{
                padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'var(--accent)', color: 'var(--ink)',
                border: 'none', cursor: 'pointer',
              }}>Delete {selectedIds.size}</button>
            )}
          </div>
        )}

        {/* Roster table */}
        <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '24px 32px minmax(140px, 1fr) 70px 70px 70px 70px 80px 60px',
            gap: 10, padding: '10px 14px',
            background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>
            <div></div>
            <div></div>
            <div>Name</div>
            <div>Format</div>
            <div>Tier</div>
            <div style={{ textAlign: 'right' }}>Open</div>
            <div style={{ textAlign: 'right' }}>Done</div>
            <div>Active</div>
            <div></div>
          </div>
          {editors.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
              No editors yet — add one above.
            </div>
          )}
          {editors.map((e, i) => {
            const c = counts[e.id] || { open: 0, done: 0 }
            const color = editorColor(e)
            const isSel = selectedIds.has(e.id)
            return (
              <div key={e.id} onClick={() => onOpenEditor(e)} style={{
                display: 'grid',
                gridTemplateColumns: '24px 32px minmax(140px, 1fr) 70px 70px 70px 70px 80px 60px',
                gap: 10, padding: '10px 14px', alignItems: 'center',
                borderBottom: i === editors.length - 1 ? 'none' : '1px solid var(--rule)',
                cursor: 'pointer', transition: 'background 0.12s',
                opacity: e.active ? 1 : 0.55,
                background: isSel ? 'rgba(244,225,74,0.15)' : 'transparent',
              }}
                onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = 'transparent' }}>
                {isSelf(e.id) ? (
                  <div title="This is you — you can't remove your own access"
                    style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="var(--ink-4)" strokeWidth="1.5" />
                      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="var(--ink-4)" strokeWidth="1.5" />
                    </svg>
                  </div>
                ) : (
                  <div onClick={ev => { ev.stopPropagation(); toggleSel(e.id) }}
                    style={{
                      width: 16, height: 16, borderRadius: 2,
                      border: isSel ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                      background: isSel ? 'var(--accent)' : 'var(--paper)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer',
                    }}>
                    {isSel && (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )}
                <span style={{ width: 18, height: 18, borderRadius: 3, background: color }} />
                <div style={{ fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
                  {e.name}
                  {!e.active && <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>(inactive)</span>}
                </div>
                <div>
                  <FormatBadge format={e.format} />
                </div>
                <div>
                  <TierBadge tier={e.tier} />
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>{c.open}</div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>{c.done}</div>
                <div>
                  <label onClick={ev => ev.stopPropagation()}
                    title={isSelf(e.id) ? "You can't deactivate yourself" : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: isSelf(e.id) ? 'not-allowed' : 'pointer' }}>
                    <input type="checkbox" checked={e.active} disabled={isSelf(e.id)}
                      onChange={() => toggleActive(e)} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                      {e.active ? 'Active' : 'Off'}
                    </span>
                  </label>
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                  Edit
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

/* Dedicated share-with-editor modal — opens straight from the toolbar so
   Ben doesn't have to dig through Manage Editors → click row → scroll.
   Two link types:
     1. TEAM-WIDE link (no editor_id binding) — anyone can see the whole queue
     2. Per-editor links (editor_id bound) — filtered to one editor's tasks */
// Copy text to the clipboard with a legacy fallback. The async Clipboard API
// throws (and we were swallowing it with an empty catch) when the document
// isn't focused, the context isn't secure, or the browser/webview doesn't
// expose navigator.clipboard — which made "Copy link" silently do nothing.
// Falls back to a hidden-textarea + execCommand('copy'). Returns true on
// success so callers can show real feedback instead of a fake "Copied".
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function ShareLinksModal({ editors, onClose }) {
  const [links, setLinks] = useState({})   // editor_id -> link row
  const [teamLink, setTeamLink] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyEditor, setBusyEditor] = useState(null)
  const [busyTeam, setBusyTeam] = useState(false)
  const [copyOk, setCopyOk] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          setErr('Migration 077 not yet applied — share links unavailable')
        } else {
          const m = {}
          let team = null
          for (const link of (data || [])) {
            if (link.editor_id) {
              if (!m[link.editor_id]) m[link.editor_id] = link
            } else if (!team) {
              team = link  // most recent team-wide link
            }
          }
          setLinks(m)
          setTeamLink(team)
        }
        setLoading(false)
      })
    return () => { mounted = false }
  }, [])

  const generateTeamLink = async () => {
    setBusyTeam(true); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: null,
        label: 'Team-wide link',
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyTeam(false)
    if (error) setErr(error.message)
    else setTeamLink(data)
  }
  const revokeTeamLink = async () => {
    if (!teamLink) return
    setBusyTeam(true)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', teamLink.id)
    setTeamLink(null)
    setBusyTeam(false)
  }

  const generate = async (editor) => {
    setBusyEditor(editor.id); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyEditor(null)
    if (error) setErr(error.message)
    else setLinks({ ...links, [editor.id]: data })
  }

  const revoke = async (link) => {
    setBusyEditor(link.editor_id); setErr(null)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', link.id)
    const next = { ...links }
    delete next[link.editor_id]
    setLinks(next)
    setBusyEditor(null)
  }

  const buildUrl = (token) => `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    const ok = await copyTextToClipboard(buildUrl(token))
    if (ok) { setErr(null); setCopyOk(token); setTimeout(() => setCopyOk(null), 1800) }
    else setErr('Couldn’t copy automatically — select the link text and copy it (Ctrl/Cmd+C).')
  }

  return (
    <Modal open={true} onClose={onClose} size="lg"
      eyebrow="Share"
      title="Share the editor portal"
      subtitle="One link the whole team uses, OR per-editor links. No login required for either."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        {loading ? (
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* Team-wide link — the primary CTA. One link, everyone sees
                everything, can upload their own finished work, can update
                their own task status. */}
            <div style={{
              padding: '16px 18px', marginBottom: 20,
              background: '#fffaea', border: '2px solid #e8b408',
              borderRadius: 2,
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7a4e08',
                marginBottom: 4,
              }}>Team-wide link · recommended</div>
              <div style={{
                fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500,
                color: 'var(--ink)', marginBottom: 12,
              }}>
                One link for the whole editing team
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center',
              }}>
                {teamLink ? (
                  <>
                    <div style={{
                      padding: '8px 12px', background: 'var(--paper)', border: '1px solid var(--rule)',
                      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      userSelect: 'all', cursor: 'text',
                    }} title={buildUrl(teamLink.token)}>{buildUrl(teamLink.token)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => copyLink(teamLink.token)} style={{
                        padding: '8px 16px',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: copyOk === teamLink.token ? '#3e8a5e' : '#e8b408',
                        color: copyOk === teamLink.token ? 'white' : '#3a2a08',
                        border: 'none', cursor: 'pointer',
                      }}>{copyOk === teamLink.token ? '✓ Copied' : '↗ Copy link'}</button>
                      <button onClick={revokeTeamLink} disabled={busyTeam} style={{
                        padding: '8px 12px',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: '#b53e3e',
                        border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                      }}>Revoke</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
                      No team-wide link yet
                    </span>
                    <button onClick={generateTeamLink} disabled={busyTeam} style={{
                      padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: '#e8b408', color: '#3a2a08',
                      border: 'none', cursor: 'pointer',
                    }}>{busyTeam ? '…' : '+ Generate team link'}</button>
                  </>
                )}
              </div>
              <p style={{
                marginTop: 10, fontFamily: 'var(--serif)', fontSize: 12.5,
                color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.45, margin: '10px 0 0',
              }}>
                Anyone with this link sees the whole queue (all editors' tasks), the full creative
                library, and can <strong>upload finished work</strong> — even without an assigned task.
                You review + assign it from your admin view. They can't delete creatives or manage
                editors.
              </p>
            </div>

            {/* Per-editor links — secondary */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
              marginBottom: 10,
            }}>Per-editor links (optional)</div>
            {editors.length === 0 ? (
              <div style={{
                padding: 16, textAlign: 'center', border: '1px dashed var(--rule)',
                fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12,
              }}>
                No active editors. Add one in Manage editors first.
              </div>
            ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {editors.map(e => {
              const link = links[e.id]
              const color = editorColor(e)
              return (
                <div key={e.id} style={{
                  padding: '12px 14px', background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 14, alignItems: 'center',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: color }} />
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{e.name}</span>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    {link ? (
                      <div style={{
                        padding: '6px 10px', background: 'var(--paper-2)',
                        border: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        userSelect: 'all', cursor: 'text',
                      }} title={buildUrl(link.token)}>{buildUrl(link.token)}</div>
                    ) : (
                      <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12 }}>
                        No active link yet
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {link ? (
                      <>
                        <button onClick={() => copyLink(link.token)} style={{
                          padding: '6px 12px',
                          fontFamily: 'var(--mono)', fontSize: 10.5,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: copyOk === link.token ? '#3e8a5e' : 'var(--ink)',
                          color: copyOk === link.token ? 'white' : 'var(--paper)',
                          border: 'none', cursor: 'pointer',
                        }}>{copyOk === link.token ? '✓ Copied' : '↗ Copy link'}</button>
                        <button onClick={() => revoke(link)}
                          disabled={busyEditor === e.id} style={{
                            padding: '6px 10px',
                            fontFamily: 'var(--mono)', fontSize: 10,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: 'transparent', color: '#b53e3e',
                            border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                          }}>Revoke</button>
                      </>
                    ) : (
                      <button onClick={() => generate(e)}
                        disabled={busyEditor === e.id} style={primaryBtn}>
                        {busyEditor === e.id ? '…' : 'Generate'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p style={{
          marginTop: 14, fontFamily: 'var(--serif)', fontSize: 12.5,
          color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.5,
        }}>
          Per-editor links narrow the view to that editor's tasks only. Use these
          if you want a contractor to see exactly what they're working on and nothing else.
        </p>
          </>
        )}
      </div>
    </Modal>
  )
}

export function EditEditorModal({ editor, selfEditorId, onClose, onSavedPatch, onDeleted }) {
  const [name, setName] = useState(editor.name || '')
  const [email, setEmail] = useState(editor.email || '')
  const [active, setActive] = useState(editor.active !== false)
  const [notes, setNotes] = useState(editor.notes || '')
  const [color, setColor] = useState(editor.color || '')
  const [format, setFormat] = useState(editor.format || 'both')
  const [tier, setTier] = useState(editor.tier || 'editor')
  // Flat pay rate in $/finished-minute. Drives the editor's Invoice tab.
  const [ratePerMinute, setRatePerMinute] = useState(
    editor.rate_per_minute != null ? String(editor.rate_per_minute) : ''
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)
  // Self-lockout guard: a coordinator editing their own row from the
  // portal can't deactivate / delete / demote themselves. selfEditorId is
  // null for Ben on the dashboard, so nothing is blocked there.
  const isSelf = selfEditorId != null && editor.id === selfEditorId
  // Share links state — load existing + allow generate / revoke
  const [links, setLinks] = useState([])
  const [linksLoading, setLinksLoading] = useState(true)
  const [copyOk, setCopyOk] = useState(null)

  const [linksAvailable, setLinksAvailable] = useState(true)
  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .eq('editor_id', editor.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          // Migration 077 hasn't been applied yet — degrade gracefully
          setLinksAvailable(false)
        } else {
          setLinks(data || [])
        }
        setLinksLoading(false)
      })
    return () => { mounted = false }
  }, [editor.id])

  const generateLink = async () => {
    // Random URL-safe token, 28 chars
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    if (error) setErr(error.message)
    else setLinks([data, ...links])
  }
  const revokeLink = async (id) => {
    const { error } = await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
    if (error) setErr(error.message)
    else setLinks(links.map(l => l.id === id ? { ...l, revoked_at: new Date().toISOString() } : l))
  }
  const buildUrl = (token) =>
    `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    const ok = await copyTextToClipboard(buildUrl(token))
    if (ok) { setErr(null); setCopyOk(token); setTimeout(() => setCopyOk(null), 1800) }
    else setErr('Couldn’t copy automatically — select the link text and copy it (Ctrl/Cmd+C).')
  }

  const save = async () => {
    setBusy(true); setErr(null)
    const patch = {
      name: name.trim(),
      // email enables magic-link login on /editor-login. Store lowercased
      // for case-insensitive matching against auth.user.email.
      email: email.trim() ? email.trim().toLowerCase() : null,
      active, notes: notes || null, color: color || null,
      format, tier,
      // Empty input clears the rate (null). Anything else parses to a
      // number; a non-numeric string falls back to null rather than NaN.
      rate_per_minute: ratePerMinute.trim() === '' ? null
        : (Number.isFinite(parseFloat(ratePerMinute)) ? parseFloat(ratePerMinute) : null),
    }
    const { error } = await supabase.from('lib_creative_editors')
      .update(patch).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSavedPatch?.(patch)  // parent merges in place; no full refetch
  }
  const deactivate = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: false }).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSavedPatch?.({ active: false })  // soft-deactivate, keep editor in roster
  }
  // Hard delete — removes the row entirely. Editing tasks that referenced
  // this editor get editor_id=NULL via ON DELETE SET NULL (per migration 075).
  const hardDelete = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .delete().eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.(editor.id)
  }
  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Edit editor"
      title={editor.name}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDeactivate ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Deactivate this editor? Their existing tasks stay.</span>
              <button onClick={() => setConfirmDeactivate(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={deactivate} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Deactivate'}
              </button>
            </>
          ) : confirmHardDelete ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>
                Permanently delete? Their existing tasks become Unassigned. Can't be undone.
              </span>
              <button onClick={() => setConfirmHardDelete(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={hardDelete} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Delete forever'}
              </button>
            </>
          ) : (
            <>
              {isSelf ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)', marginRight: 'auto', fontStyle: 'italic' }}>
                  This is you — you can't deactivate, delete, or change your own permission.
                </span>
              ) : (
                <>
                  <button onClick={() => setConfirmDeactivate(true)} disabled={busy} style={{
                    ...ghostBtn, color: 'var(--ink-3)', borderColor: 'var(--rule)', marginRight: 4,
                  }}>Deactivate</button>
                  <button onClick={() => setConfirmHardDelete(true)} disabled={busy} style={{
                    ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
                  }}>Delete forever</button>
                </>
              )}
              <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={save} disabled={!name.trim() || busy} style={primaryBtn}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        <Field label="Name">
          <input type="text" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Email — enables magic-link login at /editor-login">
          <input type="email" value={email}
            placeholder="dean@opt.co.nz"
            onChange={e => setEmail(e.target.value)}
            style={inputStyle} />
          <div style={{
            marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10,
            color: editor.auth_user_id ? '#3e8a5e' : 'var(--ink-4)',
            letterSpacing: '0.04em',
          }}>
            {editor.auth_user_id
              ? 'This editor has logged in at least once'
              : email.trim()
                ? 'Send them /editor-login — they enter this email + get a magic link'
                : 'Without an email, this editor can only access via legacy share-link token'}
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Format">
            <select value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
              <option value="shorts">Shorts</option>
              <option value="long">Long-form</option>
              <option value="both">Both</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              What this editor primarily cuts. Used to filter assignment pickers.
            </div>
          </Field>
          <Field label="Permission">
            <select value={tier} onChange={e => setTier(e.target.value)} disabled={isSelf} style={inputStyle}>
              <option value="editor">Editor</option>
              <option value="admin">Admin (manages editors)</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              {isSelf
                ? "You can't change your own permission."
                : 'Admins can invite, remove + set permissions for editors from the portal. Does not grant sales-dashboard access.'}
            </div>
          </Field>
        </div>
        <Field label="Pay rate — dollars per finished minute">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink-3)' }}>$</span>
            <input type="number" min="0" step="0.01" value={ratePerMinute}
              placeholder="0.00"
              onChange={e => setRatePerMinute(e.target.value)}
              style={{ ...inputStyle, maxWidth: 140 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>/ min</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            Applied to the total approved video time in this editor's Invoice tab. Leave blank to show minutes only.
          </div>
        </Field>
        <Field label="Color">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Reset to auto (hash-derived) */}
            <button type="button" onClick={() => setColor('')}
              title="Use the auto color (hash from name)"
              style={{
                width: 28, height: 28, borderRadius: 4,
                background: 'repeating-linear-gradient(45deg, var(--paper), var(--paper) 4px, var(--rule) 4px, var(--rule) 6px)',
                border: !color ? '2px solid var(--ink)' : '1px solid var(--rule)',
                cursor: 'pointer',
              }} />
            {EDITOR_COLORS.map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                title={c}
                style={{
                  width: 28, height: 28, borderRadius: 4,
                  background: c,
                  border: color === c ? '2px solid var(--ink)' : '1px solid rgba(0,0,0,0.15)',
                  cursor: 'pointer',
                }} />
            ))}
            <input type="color" value={color || editorColor({ slug: editor.slug, color: null })}
              onChange={e => setColor(e.target.value)}
              title="Pick a custom hex color"
              style={{ width: 28, height: 28, border: '1px solid var(--rule)', borderRadius: 4, cursor: 'pointer', background: 'var(--paper)', padding: 0 }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            {color ? `Custom: ${color}` : 'Auto (hash of name)'}
          </div>
        </Field>
        <Field label="Active">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--sans)', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            Editor is currently working on the team
          </label>
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Internal notes about this editor (specialty, working hours, etc.)" />
        </Field>

        {/* Share links — for giving editors a public /editor-view URL */}
        <Field label="Share link">
          {linksLoading ? (
            <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>Loading…</div>
          ) : !linksAvailable ? (
            <div style={{
              padding: '10px 12px', background: 'rgba(184,106,12,0.08)',
              border: '1px solid rgba(184,106,12,0.3)',
              fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-2)',
            }}>
              <strong>Pending migration 077.</strong> Apply <code style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--paper)', padding: '1px 5px' }}>supabase/migrations/077_editor_share_links.sql</code> in Supabase Studio → SQL Editor to enable share links. Existing functionality is unaffected.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {links.filter(l => !l.revoked_at).map(l => (
                <div key={l.id} style={{
                  padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      userSelect: 'all', cursor: 'text',
                    }}>{buildUrl(l.token)}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 2 }}>
                      Created {new Date(l.created_at).toLocaleDateString()}
                      {l.last_used_at && ` · last used ${new Date(l.last_used_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button onClick={() => copyLink(l.token)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: copyOk === l.token ? '#3e8a5e' : 'var(--paper)',
                    color: copyOk === l.token ? 'white' : 'var(--ink-2)',
                    border: '1px solid ' + (copyOk === l.token ? '#3e8a5e' : 'var(--rule)'),
                    cursor: 'pointer',
                  }}>{copyOk === l.token ? 'Copied' : 'Copy'}</button>
                  <button onClick={() => revokeLink(l.id)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'transparent', color: '#b53e3e',
                    border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                  }}>Revoke</button>
                </div>
              ))}
              <button onClick={generateLink} style={{
                ...ghostBtn, justifySelf: 'flex-start',
              }}>+ Generate share link</button>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                Anyone with the link can view {editor.name}'s queue + the creative library, and update
                task status. They can't delete creatives, change canonical names, or manage editors.
                Revoke to kill access.
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  )
}

export function AddEditorModal({ onClose, onSaved }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [format, setFormat] = useState('both')  // shorts | long | both
  const [tier, setTier] = useState('editor')    // editor | admin
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // After a successful add we show a confirmation (incl. invite outcome)
  // instead of closing, so the admin can see whether the welcome email
  // went out and add another in one sitting. { name, email, inviteStatus }
  const [result, setResult] = useState(null)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const cleanEmail = email.trim() ? email.trim().toLowerCase() : null
    const { error } = await supabase.from('lib_creative_editors').insert({
      name: name.trim(),
      slug,
      // Email enables magic-link login. Lowercased for case-insensitive
      // matching against auth.user.email. Optional — editor can be
      // added without one and gets onboarded via legacy share-link.
      email: cleanEmail,
      format,
      tier,
    })
    if (error) { setBusy(false); setErr(error.message); return }
    // Auto-send the branded welcome invite (best-effort). The row exists
    // now, so the Edge Function's active-roster guard will find it.
    const inviteStatus = await sendEditorInvite(cleanEmail, name.trim())
    setBusy(false)
    setResult({ name: name.trim(), email: cleanEmail, inviteStatus })
  }
  const addAnother = () => {
    setResult(null); setName(''); setEmail(''); setFormat('both'); setTier('editor'); setErr(null)
  }
  // onSaved closes + reloads the parent roster. Used by Done after the
  // confirmation, so freshly-added editors show up on close.
  const finish = () => onSaved?.()

  if (result) {
    const { inviteStatus } = result
    const inviteLine =
      inviteStatus === 'sent'    ? { color: '#3e8a5e', text: `Invite emailed to ${result.email}. They log in at /editor-login — no password needed.` }
      : inviteStatus === 'skipped' ? { color: 'var(--ink-3)', text: 'No email yet — add one via Edit to enable their login + send an invite.' }
      :                            { color: '#a8650f', text: `Couldn't send the invite email. ${result.name} can still log in at /editor-login with ${result.email || 'their email'} — or resend later.` }
    return (
      <Modal open={true} onClose={finish} size="sm"
        eyebrow="Editor added"
        title={result.name}
        footer={
          <>
            <button onClick={addAnother} style={ghostBtn}>Add another</button>
            <button onClick={finish} style={primaryBtn}>Done</button>
          </>
        }>
        <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
          <div style={{
            padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
            borderLeft: '3px solid var(--accent)',
            fontFamily: 'var(--sans)', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.5,
          }}>
            <strong>{result.name}</strong> is now on the editor roster.
          </div>
          <div style={{
            fontFamily: 'var(--sans)', fontSize: 13, color: inviteLine.color, lineHeight: 1.5,
          }}>
            {inviteLine.text}
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="New editor"
      title="Add an editor"
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || busy} style={primaryBtn}>
            {busy ? 'Adding…' : 'Add + invite'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        <Field label="Name">
          <input type="text" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Sarah" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </Field>
        <Field label="Email — sends a login invite (recommended)">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="sarah@opt.co.nz" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            With an email we send a branded welcome + they log in at /editor-login. Without one, they can only be reached via a legacy share link.
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Format">
            <select value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
              <option value="shorts">Shorts</option>
              <option value="long">Long-form</option>
              <option value="both">Both</option>
            </select>
          </Field>
          <Field label="Permission">
            <select value={tier} onChange={e => setTier(e.target.value)} style={inputStyle}>
              <option value="editor">Editor</option>
              <option value="admin">Admin (manages editors)</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              Admins can invite, remove + set permissions for editors from the portal. Does not grant sales-dashboard access.
            </div>
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export function AddTaskModal({ editors, onClose, onSaved, prefillEditorId = '', prefillDue = '', prefillStart = '', existingTaskCreativeIds = null }) {
  const [mode, setMode] = useState('pick')   // 'pick' or 'upload'
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  // Default: only show creatives that need editing (status='raw'),
  // hide stuff that's already been edited (Body/Hook/Joined-edited
  // sitting in the library as finished outputs). Ben asked for this
  // because the modal was firehosing 50 already-edited Body files
  // before the operator could find a raw clip to assign.
  const [statusFilter, setStatusFilter] = useState('raw')  // 'raw' | 'all'
  // Default: hide creatives that already have an open editing task —
  // no point re-assigning something that's already in someone's queue.
  const [hideAssigned, setHideAssigned] = useState(true)
  // Selected creative(s) — Set of ids. UI toggles between single and multi:
  // checkbox per row + a "Select all visible" affordance.
  const [creativeIds, setCreativeIds] = useState(() => new Set())
  // Upload-mode state. Multi-file: dropping N files creates N library
  // rows + N tasks in one go (Ben 2026-06-11 — "bulk upload isn't
  // available here"). With one file the name stays editable; with
  // several, names derive from the filenames.
  const [uploadFiles, setUploadFiles] = useState([])
  const [uploadName, setUploadName] = useState('')
  const [uploadType, setUploadType] = useState('Joined')
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)
  // Common state — accept pre-fill from Timeline drag
  const [editorId, setEditorId] = useState(prefillEditorId || '')
  const [taskType, setTaskType] = useState('edit')
  const [priority, setPriority] = useState('P2 - Medium')
  const [due, setDue] = useState(prefillDue || '')
  // Optional start date — if user dragged across multiple days in the
  // timeline, we capture the first day as the task's assigned_at.
  const [startDate, setStartDate] = useState(prefillStart || '')
  // Optional project name applied as canonical_name prefix when assigning
  // multiple creatives at once — Ben asked to "rename the project for
  // multiple videos" in one shot from this modal.
  const [projectName, setProjectName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    // Pull status + manually_marked_used too so we can client-side
    // filter to "raw / needs editing" without a second query when the
    // operator flips the toggle.
    supabase.from('lib_creative_library')
      .select('id,name,canonical_name,type,creator,thumbnail_url,description,status,manually_marked_used')
      .eq('exclude_from_library', false)
      .order('canonical_name', { ascending: true })
      .limit(500)
      .then(({ data }) => setCreatives(data || []))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const assignedSet = existingTaskCreativeIds instanceof Set
      ? existingTaskCreativeIds
      : new Set(existingTaskCreativeIds || [])
    const matchesStatus = (c) => {
      if (statusFilter === 'all') return true
      // 'raw' = needs editing. Library uses status='raw' to mark the
      // pre-edited source, status='edited' for finished outputs.
      // manually_marked_used=true means the operator has flagged an
      // otherwise-raw clip as already-used elsewhere (don't reassign).
      return c.status === 'raw' && c.manually_marked_used !== true
    }
    const matchesSearch = (c) => {
      if (!q) return true
      return (rowDisplayName(c) || '').toLowerCase().includes(q)
          || (c.name || '').toLowerCase().includes(q)
    }
    const matchesAssigned = (c) => {
      if (!hideAssigned) return true
      return !assignedSet.has(c.id)
    }
    return creatives
      .filter(c => matchesStatus(c) && matchesAssigned(c) && matchesSearch(c))
      .slice(0, 50)
  }, [creatives, search, statusFilter, hideAssigned, existingTaskCreativeIds])

  // Counts so the operator sees what each filter is doing.
  const rawCount     = useMemo(() => creatives.filter(c => c.status === 'raw' && c.manually_marked_used !== true).length, [creatives])
  const editedCount  = useMemo(() => creatives.length - rawCount, [creatives, rawCount])

  const onFilePick = (fileList) => {
    const files = Array.from(fileList || []).filter(f => f && f.size > 0)
    if (!files.length) return
    setUploadFiles(files)
    // Single file: auto-fill the editable name from the filename.
    if (files.length === 1 && !uploadName) setUploadName(files[0].name.replace(/\.[^.]+$/, ''))
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      let cids = []
      // Upload mode: upload each file → insert a library row each → one
      // task per row. Sequential per file (TUS chunks parallelise within
      // a file already); overall progress maps file i of N onto 10-85%.
      if (mode === 'upload') {
        if (!uploadFiles.length || (uploadFiles.length === 1 && !uploadName.trim())) {
          setErr('Pick at least one file (and a name for a single file)'); setBusy(false); return
        }
        const n = uploadFiles.length
        const span = 75 / n   // each file's slice of the 10-85% window
        for (let i = 0; i < n; i++) {
          const file = uploadFiles[i]
          const base = 10 + i * span
          setUploadProgress(Math.floor(base))
          const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
          const storagePath = `edited/${Date.now()}_${sanitized}`
          // Resumable upload (TUS) — single-POST .upload() silently failed
          // on multi-hundred-MB files routed through "+ Add task". 6MB
          // chunks, retries, fingerprinted by (bucket,path), and refuses
          // to resolve unless verifyUploaded confirms the object exists.
          let lastUploadPct = -1
          await uploadWithResume(file, {
            bucket: 'creative-uploads',
            path: storagePath,
            contentType: file.type || 'video/mp4',
            onProgress: (frac) => {
              const pct = Math.floor(base + frac * span * 0.7)
              if (pct !== lastUploadPct) { lastUploadPct = pct; setUploadProgress(pct) }
            },
          })
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`

          // Thumbnail: pre-upload File path first (fast, < 500 MB) then
          // post-upload URL path (HTTP-range, any size) — without it the
          // new row lands as a black square on the kanban.
          let thumbnailUrl = null
          let thumbBlob = await captureVideoThumbnail(file)
          if (!thumbBlob) {
            thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
          }
          if (thumbBlob) {
            const thumbPath = `edited/${Date.now()}_${sanitized}_thumb.jpg`
            const { error: thumbErr } = await supabase.storage
              .from('creative-uploads')
              .upload(thumbPath, thumbBlob, { upsert: true, contentType: 'image/jpeg' })
            if (!thumbErr) {
              thumbnailUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${thumbPath}`
            }
          }

          const ext = (file.name.match(/\.[^.]+$/) || [''])[0]
          const rowName = n === 1
            ? uploadName.trim() + ext
            : file.name   // bulk: filenames are the names
          const { data: newRow, error: insErr } = await supabase.from('lib_creative_library')
            .insert({
              name: rowName,
              type: uploadType,
              size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
              status: 'review',
              source_bucket: 'Editor upload (via Add task)',
              preview_url: publicUrl,
              drive_url: publicUrl,
              thumbnail_url: thumbnailUrl,
              notes: `Uploaded ${new Date().toISOString().slice(0,10)} alongside a new task. Pending review + assignment.`,
            })
            .select()
            .single()
          if (insErr) throw insErr
          cids.push(newRow.id)
        }
        setUploadProgress(85)
      } else {
        cids = Array.from(creativeIds)
      }
      if (cids.length === 0) { setErr('Pick one or more creatives or upload a new file'); setBusy(false); return }

      // Optional: tag the picked creatives with a shared project name.
      // PRE-2026-05-31 BEHAVIOUR was to overwrite canonical_name with
      // "<projectName> 1", "<projectName> 2", ... — that produced messes
      // like JOINED-OSO-ERIC-GOOGLERANKINGRES-T01.mp4 that don't match
      // the auto-generated bulletproof format and made the editor view
      // unreadable. The shared tag now lives in project_tag (filterable,
      // groupable) and the display_name stays untouched.
      // Self-heal pattern: if migration 103 hasn't been applied yet, the
      // project_tag column won't exist and a 42703 error would kill the
      // whole assign-creative flow. Catch the column-missing error and
      // continue silently — the rest of the task assignment still lands.
      if (projectName.trim() && mode === 'pick') {
        const proj = projectName.trim()
        for (const id of cids) {
          const { error: rnErr } = await supabase.from('lib_creative_library')
            .update({ project_tag: proj })
            .eq('id', id)
          if (rnErr && rnErr.code !== '42703') throw rnErr
          if (rnErr && rnErr.code === '42703') {
            // Migration 103 not applied yet. Log once + stop trying the
            // remaining IDs — they'd all hit the same error.
            console.warn('project_tag column missing — apply migration 103 to enable project tagging. Skipping tag write.')
            break
          }
        }
      }

      // Insert ONE task per selected creative
      // If the user dragged across days in Timeline, startDate is set —
      // we use it as assigned_at so the bar in Timeline spans from start
      // to due_date instead of from "now" to due.
      const assignedAt = startDate ? new Date(startDate + 'T00:00:00Z').toISOString() : null
      const rows = cids.map(creative_id => ({
        creative_id,
        editor_id: editorId || null,
        task_type: taskType, priority, due_date: due || null,
        ...(assignedAt ? { assigned_at: assignedAt } : {}),
        status: editorId ? 'queued' : 'review',
      }))
      // Insert + return the new rows joined as they appear in
      // lib_editing_queue so the parent can optimistically prepend
      // them to its state. Without this, the parent has to refetch
      // and the new task doesn't visibly land in the queue until the
      // refetch returns (or the user reloads). Ben flagged this as
      // "kind of annoying" 2026-05-23.
      const { data: insertedIds, error: taskErr } = await supabase
        .from('lib_editing_tasks')
        .insert(rows)
        .select('id')
      if (taskErr) throw taskErr
      // Pull the queue-view rows for the just-inserted task ids so the
      // shape matches what the parent already has in state.
      let newQueueRows = []
      if (insertedIds && insertedIds.length) {
        const ids = insertedIds.map(r => r.id)
        const { data: viewRows } = await supabase
          .from('lib_editing_queue')
          .select('*')
          .in('task_id', ids)
        if (viewRows) newQueueRows = viewRows
      }
      setUploadProgress(100)
      onSaved?.(newQueueRows)
    } catch (e) {
      setErr(e.message || 'failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'pick'
    ? creativeIds.size > 0
    : uploadFiles.length > 0 && (uploadFiles.length > 1 || !!uploadName.trim())
  const toggleCreative = (id) => {
    setCreativeIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="New task"
      title="Add a task"
      subtitle="Either pick an existing creative to assign, or upload your finished output and we'll create a new library row for it."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit || busy} style={primaryBtn}>
            {busy
              ? (mode === 'upload' ? `Uploading… ${uploadProgress || 0}%` : 'Adding…')
              : (mode === 'upload'
                  ? (uploadFiles.length > 1 ? `Upload ${uploadFiles.length} + add tasks` : 'Upload + add task')
                  : 'Add task')}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Mode tabs */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
          <button onClick={() => setMode('pick')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'pick' ? 'var(--ink)' : 'transparent',
            color: mode === 'pick' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>Pick existing</button>
          <button onClick={() => setMode('upload')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'upload' ? 'var(--ink)' : 'transparent',
            color: mode === 'upload' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>↗ Upload new file</button>
        </div>

        {mode === 'pick' ? (
          <>
            <Field label={`Creatives ${creativeIds.size > 0 ? `· ${creativeIds.size} selected` : ''}`}>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name…" style={{ ...inputStyle, marginBottom: 8 }} />
              {/* Two-tab status filter: default to RAW (needs editing).
                  Without this the modal firehoses 50 already-edited Body
                  files at the top and the operator has to scroll to find
                  a raw clip. Ben's ask 2026-05-23. */}
              <div style={{
                display: 'flex', gap: 4, marginBottom: 8,
                border: '1px solid var(--rule)', padding: 3,
              }}>
                {[
                  { value: 'raw', label: `Needs editing · ${rawCount}` },
                  { value: 'all', label: `All · ${rawCount + editedCount}` },
                ].map(opt => {
                  const selected = statusFilter === opt.value
                  return (
                    <button key={opt.value} type="button"
                      onClick={() => setStatusFilter(opt.value)}
                      style={{
                        flex: 1, padding: '6px 8px', cursor: 'pointer',
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: selected ? 'var(--ink)' : 'transparent',
                        color: selected ? 'var(--paper)' : 'var(--ink-3)',
                        border: 'none',
                      }}>{opt.label}</button>
                  )
                })}
              </div>
              {/* Hide-assigned toggle. Prevents the operator from picking
                  a creative that's already in someone else's task queue. */}
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginBottom: 8, cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
              }}>
                <input type="checkbox" checked={hideAssigned}
                  onChange={e => setHideAssigned(e.target.checked)} />
                Hide creatives already in an open task
              </label>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginBottom: 6, gap: 8,
              }}>
                <button type="button"
                  onClick={() => setCreativeIds(new Set(filtered.map(c => c.id)))}
                  style={{
                    padding: '4px 9px',
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                    textTransform: 'uppercase', background: 'transparent',
                    border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-2)',
                  }}>Select all visible ({filtered.length})</button>
                {creativeIds.size > 0 && (
                  <button type="button" onClick={() => setCreativeIds(new Set())}
                    style={{
                      padding: '4px 9px',
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                      textTransform: 'uppercase', background: 'transparent',
                      border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-3)',
                    }}>Clear</button>
                )}
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--rule)' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 12, fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>
                    No matches.
                  </div>
                )}
                {filtered.map(c => {
                  const isOn = creativeIds.has(c.id)
                  return (
                    <div key={c.id}
                      onClick={() => toggleCreative(c.id)}
                      style={{
                        padding: '6px 10px', cursor: 'pointer',
                        background: isOn ? 'rgba(244,225,74,0.18)' : 'transparent',
                        borderBottom: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11.5,
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                      <span style={{
                        width: 16, height: 16, borderRadius: 2,
                        border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                        background: isOn ? 'var(--accent)' : 'var(--paper)',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {isOn && (
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                              strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {/* Thumbnail — visual ID for cryptic canonical names */}
                      <div style={{
                        width: 48, height: 32, background: '#000',
                        border: '1px solid var(--rule)',
                        overflow: 'hidden', flexShrink: 0,
                      }}>
                        {c.thumbnail_url ? (
                          <img src={c.thumbnail_url} alt="" loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        ) : (
                          <div style={{
                            width: '100%', height: '100%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                          }}>—</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontWeight: 500,
                        }}>{rowDisplayName(c)}</div>
                        {c.description && (
                          <div style={{
                            fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-3)',
                            marginTop: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{c.description}</div>
                        )}
                      </div>
                      <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>{c.type}</span>
                    </div>
                  )
                })}
              </div>
            </Field>
            {/* Project tag — applies a shared project_tag to all selected
                creatives WITHOUT touching their display_name. Lets you
                group / filter by project ("HAMMER campaign") without
                trashing the bulletproof name format. */}
            {creativeIds.size > 0 && (
              <Field label={creativeIds.size === 1 ? 'Optional: project tag' : `Optional: tag all ${creativeIds.size} with a project name`}>
                <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)}
                  placeholder='e.g. HAMMER campaign'
                  style={inputStyle} />
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 4 }}>
                  Filter by this tag in the library. Display names stay intact.
                </div>
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Upload your finished files">
              <div
                onClick={() => !busy && uploadInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); onFilePick(e.dataTransfer.files) }}
                onDragOver={e => e.preventDefault()}
                style={{
                  padding: 24, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
                  border: '2px dashed var(--rule)',
                  background: uploadFiles.length ? 'var(--paper)' : 'var(--paper-2)',
                }}>
                <input ref={uploadInputRef} type="file" accept="video/*" multiple
                  style={{ display: 'none' }}
                  onChange={e => onFilePick(e.target.files)} />
                {uploadFiles.length > 0 ? (
                  <>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>
                      {uploadFiles.length === 1
                        ? uploadFiles[0].name
                        : `${uploadFiles.length} files — one task each`}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                      {(uploadFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB total · click to change
                    </div>
                    {uploadFiles.length > 1 && (
                      <div style={{
                        marginTop: 8, textAlign: 'left', maxHeight: 110, overflowY: 'auto',
                        fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', lineHeight: 1.7,
                      }}>
                        {uploadFiles.map(f => <div key={f.name}>· {f.name}</div>)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                      Drop your finished file(s) here
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 4 }}>
                      or click to select · multiple files = one task each
                    </div>
                  </>
                )}
              </div>
              {uploadProgress != null && (
                <div style={{ marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${uploadProgress}%`, height: '100%',
                    background: uploadProgress === 100 ? '#3e8a5e' : 'var(--accent)',
                    transition: 'width 0.2s',
                  }} />
                </div>
              )}
            </Field>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '2fr 1fr' }}>
              {uploadFiles.length <= 1 ? (
                <Field label="Name this creative">
                  <input type="text" value={uploadName} onChange={e => setUploadName(e.target.value)}
                    placeholder="e.g. 'Eric direct call breakthrough — final cut'"
                    style={inputStyle} />
                </Field>
              ) : (
                <Field label="Names">
                  <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                    Taken from each filename
                  </div>
                </Field>
              )}
              <Field label="Type">
                <select value={uploadType} onChange={e => setUploadType(e.target.value)} style={selectStyle}>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          </>
        )}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Field label="Editor (optional)">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">— Unassigned</option>
              {editors.filter(e => e.tier !== 'admin').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          {/* Task-type select removed 2026-06-11 (Ben) — new tasks default
              to 'edit'; the column and existing values are untouched. */}
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Start date">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────────────────── TIMELINE (Gantt-style) ─────────────────────── */

export function DateEditPopover({ popover, onClose, onSave, onFullEdit }) {
  const [start, setStart] = useState(popover.startDate)
  const [due, setDue] = useState(popover.dueDate)
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey  = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = Math.min(popover.x, window.innerWidth - 256)
  const top  = Math.min(popover.y, window.innerHeight - 180)
  const inp  = { display: 'block', width: '100%', marginTop: 3, padding: '5px 8px',
                 background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3,
                 fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', boxSizing: 'border-box' }
  return (
    <div ref={ref} style={{
      position: 'fixed', left, top, zIndex: 1200, width: 236,
      background: 'var(--paper)', border: '1px solid var(--rule)',
      borderRadius: 4, padding: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'var(--ink-3)', marginBottom: 10,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {popover.task.creative_name || 'Set dates'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
          Start date<input type="date" value={start} onChange={e => setStart(e.target.value)} style={inp} />
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
          Due date<input type="date" value={due} onChange={e => setDue(e.target.value)} style={inp} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => onSave(start, due)}
          style={{ flex: 1, padding: '6px 0', background: 'var(--ink)', color: 'var(--paper)',
                   border: 'none', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11,
                   fontWeight: 600, cursor: 'pointer', letterSpacing: '0.06em' }}>Save</button>
        <button onClick={onFullEdit}
          style={{ padding: '6px 10px', background: 'transparent', color: 'var(--ink-3)',
                   border: '1px solid var(--rule)', borderRadius: 3, fontFamily: 'var(--mono)',
                   fontSize: 10, cursor: 'pointer' }}>Full edit</button>
      </div>
    </div>
  )
}
