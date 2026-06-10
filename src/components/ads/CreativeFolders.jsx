import { memo, useMemo, useState } from 'react'
import { Folder, FolderOpen, ChevronRight, MoreHorizontal } from 'lucide-react'
import Modal from '../editorial/Modal'
import ConfirmModal from '../ConfirmModal'
import { Button } from '../editorial/atoms'

/*
  Google-Drive-style folders for the Creative Library (migration 146).

  Data model: lib_creative_folders (id, name, parent_id) + folder_id on
  lib_creative_library. folder_id NULL = library root. This file is pure
  presentation + tree math — ALL database writes (folder CRUD and clip
  moves) live in the library page, which owns the optimistic state for
  both tables. Modals receive async callbacks and surface their errors.
*/

// ── Tree helpers ─────────────────────────────────────────────────────────

export function folderChildren(folders, parentId) {
  return folders
    .filter(f => (f.parent_id || null) === (parentId || null))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Breadcrumb path root→folder. Defensive against orphans/cycles: stops
// if a parent is missing or already visited.
export function folderPath(folders, id) {
  const byId = new Map(folders.map(f => [f.id, f]))
  const path = []
  const seen = new Set()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur)
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return path
}

// All ids in the subtree rooted at rootId (inclusive). One pass to build
// the parent→children index, then a stack walk — O(F).
export function subtreeIds(folders, rootId) {
  const kids = new Map()
  for (const f of folders) {
    if (!f.parent_id) continue
    if (!kids.has(f.parent_id)) kids.set(f.parent_id, [])
    kids.get(f.parent_id).push(f.id)
  }
  const ids = new Set()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    if (ids.has(id)) continue   // cycle-safe
    ids.add(id)
    for (const c of kids.get(id) || []) stack.push(c)
  }
  return ids
}

// ── Folder bar (breadcrumb + cards) ──────────────────────────────────────

const crumbBtn = {
  padding: '6px', fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
  letterSpacing: '0.05em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-2)',
  border: 'none', cursor: 'pointer',
  // Long folder names on a phone: truncate the crumb instead of letting
  // one name push the whole trail onto four lines.
  maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}

export const FolderBar = memo(function FolderBar({
  folders, currentFolderId, onNavigate,
  clipCounts,            // Map folder_id → clip count (as shown when opened)
  searching = false,     // true while a search query is active (search is global)
  canManage,
  onCreate,              // (name) => Promise — page inserts + syncs state
  onRename,              // (folder, name) => Promise
  onDelete,              // (folder) => Promise
  onMoveFolder,          // (folder, newParentId) => Promise
  onError,               // (message) — surface a failed write on the page
}) {
  const [nameModal, setNameModal] = useState(null)   // { folder } | { create: true }
  const [confirmDel, setConfirmDel] = useState(null) // folder
  const [delBusy, setDelBusy] = useState(false)
  const [moveTarget, setMoveTarget] = useState(null) // folder being re-parented
  const [menuFor, setMenuFor] = useState(null)       // folder id with open ⋯ menu

  const path = useMemo(
    () => (currentFolderId ? folderPath(folders, currentFolderId) : []),
    [folders, currentFolderId],
  )
  const children = useMemo(
    () => folderChildren(folders, currentFolderId),
    [folders, currentFolderId],
  )
  const subfolderCount = useMemo(() => {
    const m = new Map()
    for (const f of folders) {
      if (f.parent_id) m.set(f.parent_id, (m.get(f.parent_id) || 0) + 1)
    }
    return m
  }, [folders])
  // Computed once per open confirm dialog — feeds both numbers in its copy.
  const delSubtree = useMemo(
    () => (confirmDel ? subtreeIds(folders, confirmDel.id) : null),
    [folders, confirmDel],
  )

  // Nothing to show: at root with no folders and no permission to create.
  if (!currentFolderId && folders.length === 0 && !canManage) return null

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Breadcrumb — always visible once folders exist, so the operator
          knows whether they're looking at the root or inside a folder. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', marginBottom: children.length > 0 && !searching ? 10 : 0 }}>
        <button type="button" onClick={() => onNavigate(null)}
          style={{ ...crumbBtn, color: currentFolderId ? 'var(--ink-3)' : 'var(--ink)', paddingLeft: 0 }}>
          Library
        </button>
        {path.map((f, i) => (
          <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <ChevronRight size={12} style={{ color: 'var(--ink-4)' }} />
            <button type="button" onClick={() => onNavigate(f.id)}
              style={{ ...crumbBtn, color: i === path.length - 1 ? 'var(--ink)' : 'var(--ink-3)' }}>
              {f.name}
            </button>
          </span>
        ))}
        {searching && folders.length > 0 && (
          <span style={{
            marginLeft: 6, padding: '3px 8px',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'var(--paper-2)', border: '1px solid var(--rule)',
            color: 'var(--ink-3)', borderRadius: 2,
          }}>search covers all folders</span>
        )}
        <span style={{ flex: 1 }} />
        {canManage && (
          <button type="button" onClick={() => setNameModal({ create: true })}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'white', color: 'var(--ink)',
              border: '1px solid var(--rule)', borderRadius: 2, cursor: 'pointer',
            }}>+ New folder</button>
        )}
      </div>

      {/* Invisible click-catcher so an open ⋯ menu closes on any outside
          tap — matters on touch screens where there's no hover-away. Sits
          under the menu (z 60) but over the cards. */}
      {menuFor && (
        <div onClick={() => setMenuFor(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 55 }} />
      )}

      {/* Folder cards — children of the current folder. Hidden while a
          search is active: results are global, so showing the current
          folder's cards would suggest a scope that isn't applied. */}
      {children.length > 0 && !searching && (
        <div style={{
          display: 'grid', gap: 10,
          // 160px min = two folder columns on a 375px phone; desktop still
          // packs 5-6 across. Inline styles can't media-query, so the
          // responsive behaviour all comes from auto-fill.
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        }}>
          {children.map(f => {
            const clips = clipCounts.get(f.id) || 0
            const subs = subfolderCount.get(f.id) || 0
            return (
              <div key={f.id}
                onClick={() => { setMenuFor(null); onNavigate(f.id) }}
                style={{
                  position: 'relative',
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px',
                  background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  cursor: 'pointer',
                }}>
                <Folder size={18} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600, color: 'var(--ink)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{f.name}</div>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>
                    {clips} clip{clips === 1 ? '' : 's'}{subs > 0 ? ` · ${subs} folder${subs === 1 ? '' : 's'}` : ''}
                  </div>
                </div>
                {canManage && (
                  <button type="button" aria-label={`Folder actions: ${f.name}`}
                    onClick={e => { e.stopPropagation(); setMenuFor(m => m === f.id ? null : f.id) }}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      // 8px padding ≈ 31px hit area — tappable on a phone
                      // without growing the card.
                      color: 'var(--ink-3)', padding: 8, margin: -4, flexShrink: 0,
                    }}>
                    <MoreHorizontal size={15} />
                  </button>
                )}
                {menuFor === f.id && (
                  <div onClick={e => e.stopPropagation()}
                    style={{
                      position: 'absolute', top: '100%', right: 8, zIndex: 60,
                      background: 'white', border: '1px solid var(--rule)',
                      boxShadow: '0 8px 24px rgba(10,10,10,0.12)',
                      display: 'grid', minWidth: 150,
                    }}>
                    {[
                      { label: 'Rename', act: () => setNameModal({ folder: f }) },
                      { label: 'Move folder…', act: () => setMoveTarget(f) },
                      { label: 'Delete', act: () => setConfirmDel(f), danger: true },
                    ].map(item => (
                      <button key={item.label} type="button"
                        onClick={() => { setMenuFor(null); item.act() }}
                        style={{
                          padding: '8px 12px', textAlign: 'left',
                          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: item.danger ? '#b53e3e' : 'var(--ink-2)',
                        }}>{item.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {nameModal && (
        <FolderNameModal
          folder={nameModal.folder || null}
          onClose={() => setNameModal(null)}
          onSave={async (name) => {
            if (nameModal.folder) await onRename(nameModal.folder, name)
            else await onCreate(name)
            setNameModal(null)
          }}
        />
      )}
      {confirmDel && (() => {
        const clips = Array.from(delSubtree).reduce((n, id) => n + (clipCounts.get(id) || 0), 0)
        const subs = delSubtree.size - 1
        return (
          <ConfirmModal
            open
            onClose={() => { if (!delBusy) setConfirmDel(null) }}
            title={`Delete “${confirmDel.name}”?`}
            message={
              `${subs > 0 ? `Its ${subs} subfolder${subs === 1 ? '' : 's'} will be deleted too. ` : ''}` +
              `Clips are never deleted — anything inside${clips > 0 ? ` (${clips} clip${clips === 1 ? '' : 's'})` : ''} moves back to ${confirmDel.parent_id ? 'the parent folder' : 'the library root'}.`
            }
            confirmLabel="Delete folder"
            variant="danger"
            loading={delBusy}
            onConfirm={async () => {
              setDelBusy(true)
              try {
                await onDelete(confirmDel)
                setConfirmDel(null)
              } catch (e) {
                onError?.(e.message || 'Folder delete failed')
              } finally {
                setDelBusy(false)
              }
            }}
          />
        )
      })()}
      {moveTarget && (
        <FolderPickerModal
          title={`Move “${moveTarget.name}”`}
          subtitle="Pick the destination folder. The folder keeps its contents."
          folders={folders}
          // Can't move a folder into itself/its own subtree, and moving to
          // its current parent is a no-op.
          disabledIds={subtreeIds(folders, moveTarget.id)}
          currentId={moveTarget.parent_id || null}
          onClose={() => setMoveTarget(null)}
          onPick={async (parentId) => {
            await onMoveFolder(moveTarget, parentId)
            setMoveTarget(null)
          }}
        />
      )}
    </div>
  )
})

// ── Modals ───────────────────────────────────────────────────────────────

function FolderNameModal({ folder, onClose, onSave }) {
  const [name, setName] = useState(folder?.name || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const valid = name.trim().length > 0

  const save = async () => {
    if (!valid || busy) return
    setBusy(true); setErr(null)
    try {
      await onSave(name.trim())
    } catch (e) {
      setErr(e.message || 'Save failed')
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="sm"
      eyebrow={folder ? 'FOLDER' : 'NEW FOLDER'}
      title={folder ? `Rename “${folder.name}”` : 'Create folder'}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : (folder ? 'Rename' : 'Create')}
          </Button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        <input autoFocus type="text" value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          placeholder="e.g. Electricians — Stop Paying For Leads"
          style={{
            width: '100%', padding: '8px 11px',
            fontFamily: 'var(--sans)', fontSize: 13,
            background: 'white', border: '1px solid var(--rule)', outline: 'none',
          }} />
      </div>
    </Modal>
  )
}

// Shared destination picker — used to move clips into a folder and to
// re-parent a folder. Renders the tree with indentation; "Library root"
// is always the first option.
//
// currentId semantics: pass a folder id (or null = root) when the
// caller KNOWS where the moved thing currently lives — that option is
// tagged "current" and picking it is blocked as a no-op. Pass undefined
// when the current location is unknown or mixed (e.g. a bulk selection
// gathered via global search): nothing is tagged and every destination
// including the root is pickable.
export function FolderPickerModal({
  title, subtitle, folders,
  disabledIds = new Set(),  // folders that can't be picked (e.g. own subtree)
  currentId,
  onClose, onPick,          // onPick(folderId | null) — may be async
}) {
  const hasCurrent = currentId !== undefined
  const [picked, setPicked] = useState(hasCurrent ? currentId : null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // Flatten the tree depth-first so nesting reads as indentation.
  const flat = useMemo(() => {
    const out = []
    const walk = (parentId, depth) => {
      for (const f of folderChildren(folders, parentId)) {
        out.push({ ...f, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folders])

  const rowStyle = (active, disabled) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '8px 12px', textAlign: 'left',
    fontFamily: 'var(--sans)', fontSize: 13,
    background: active ? 'var(--accent)' : 'transparent',
    color: disabled ? 'var(--ink-4)' : 'var(--ink)',
    border: 'none', borderBottom: '1px solid var(--rule)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  })

  return (
    <Modal open onClose={onClose} size="sm"
      eyebrow="FOLDERS" title={title} subtitle={subtitle}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || (hasCurrent && picked === currentId)}
            onClick={async () => {
              setBusy(true); setErr(null)
              try { await onPick(picked) } catch (e) { setErr(e.message || 'Move failed'); setBusy(false) }
            }}>
            {busy ? 'Moving…' : 'Move here'}
          </Button>
        </>
      }>
      <div>
        <button type="button" onClick={() => setPicked(null)}
          style={rowStyle(picked === null, false)}>
          <FolderOpen size={15} style={{ color: 'var(--ink-3)' }} />
          <span style={{ fontWeight: 600 }}>Library root</span>
          {hasCurrent && currentId === null && <CurrentTag />}
        </button>
        {flat.map(f => {
          const disabled = disabledIds.has(f.id)
          return (
            <button key={f.id} type="button" disabled={disabled}
              onClick={() => setPicked(f.id)}
              style={{ ...rowStyle(picked === f.id, disabled), paddingLeft: 12 + f.depth * 18 }}>
              <Folder size={15} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
              {hasCurrent && currentId === f.id && <CurrentTag />}
            </button>
          )
        })}
        {flat.length === 0 && (
          <div style={{
            padding: '18px 12px', fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>No folders yet — create one from the library toolbar.</div>
        )}
      </div>
    </Modal>
  )
}

function CurrentTag() {
  return (
    <span style={{
      marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9,
      letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)',
    }}>current</span>
  )
}
