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

// ── Drag & drop (Drive behaviour) ────────────────────────────────────────
// Clips drag from the tile/list views (payload set by the library page);
// folder cards drag to re-parent. Custom MIME types so a stray file drag
// from the OS can't trigger a move.
export const CLIP_DRAG_MIME = 'application/x-lib-clips'
export const FOLDER_DRAG_MIME = 'application/x-lib-folder'

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
  onDropClips,           // (ids, folderId|null) => Promise — clips dragged in
  dropReady = false,     // a clip drag is in flight — light up all targets
  onError,               // (message) — surface a failed write on the page
}) {
  const [nameModal, setNameModal] = useState(null)   // { folder } | { create: true }
  const [confirmDel, setConfirmDel] = useState(null) // folder
  const [delBusy, setDelBusy] = useState(false)
  const [moveTarget, setMoveTarget] = useState(null) // folder being re-parented
  const [menuFor, setMenuFor] = useState(null)       // folder id with open ⋯ menu
  const [dropHover, setDropHover] = useState(null)   // 'root' | folder id under a drag
  // Which of OUR folder cards is being dragged. dataTransfer payloads are
  // unreadable during dragover (spec), so this local mirror is the only
  // way to stop the dragged card highlighting itself as its own target.
  const [dragFolderId, setDragFolderId] = useState(null)

  // Shared drop wiring for crumbs + cards. destId null = library root.
  // The hover gate keys on MIME types alone; the drop handler re-validates.
  const isOurs = (e) =>
    e.dataTransfer.types.includes(CLIP_DRAG_MIME) || e.dataTransfer.types.includes(FOLDER_DRAG_MIME)
  const dragOver = (key) => (e) => {
    if (!isOurs(e)) return
    if (dragFolderId && key === dragFolderId) return   // a card is not its own destination
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropHover(key)
  }
  const dragLeave = (key) => () => setDropHover(h => (h === key ? null : h))
  const handleDrop = (destId) => async (e) => {
    if (!isOurs(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropHover(null)
    const clipJson = e.dataTransfer.getData(CLIP_DRAG_MIME)
    if (clipJson) {
      let ids = []
      try { ids = JSON.parse(clipJson) } catch { /* foreign payload — ignore */ }
      if (Array.isArray(ids) && ids.length) await onDropClips?.(ids, destId)
      return
    }
    const draggedId = e.dataTransfer.getData(FOLDER_DRAG_MIME)
    if (!draggedId) return
    // Accidental self-drop (press, twitch a few px, release) is by far the
    // most common gesture — Drive treats it as a silent no-op, not an error.
    if (draggedId === destId) return
    const folder = folders.find(f => f.id === draggedId)
    if (!folder) return
    if ((folder.parent_id || null) === (destId || null)) return        // already there
    if (destId && subtreeIds(folders, draggedId).has(destId)) {
      onError?.('Can’t move a folder into itself or its own subfolder')
      return
    }
    try { await onMoveFolder(folder, destId) }
    catch (err) { onError?.(err.message || 'Folder move failed') }
  }
  // Three visual states, Drive-style: drag in flight anywhere = every
  // target shows a dashed "drop here" outline; cursor over a target =
  // solid outline + fill; otherwise nothing.
  const dropTargetStyle = (key) => {
    if (dropHover === key)
      return { background: 'rgba(244,225,74,0.3)', outline: '2px solid var(--accent)', outlineOffset: -2 }
    if (dropReady)
      return { outline: '2px dashed rgba(216,201,58,0.8)', outlineOffset: -2 }
    return null
  }

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
          onDragOver={dragOver('root')} onDragLeave={dragLeave('root')} onDrop={handleDrop(null)}
          style={{ ...crumbBtn, color: currentFolderId ? 'var(--ink-3)' : 'var(--ink)', paddingLeft: 0, ...dropTargetStyle('root') }}>
          Library
        </button>
        {path.map((f, i) => (
          <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <ChevronRight size={12} style={{ color: 'var(--ink-4)' }} />
            <button type="button" onClick={() => onNavigate(f.id)}
              onDragOver={dragOver(f.id)} onDragLeave={dragLeave(f.id)} onDrop={handleDrop(f.id)}
              style={{ ...crumbBtn, color: i === path.length - 1 ? 'var(--ink)' : 'var(--ink-3)', ...dropTargetStyle(f.id) }}>
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
            color: 'var(--ink-3)', borderRadius: 9,
          }}>search covers all folders</span>
        )}
        <span style={{ flex: 1 }} />
        {canManage && (
          <button type="button" onClick={() => setNameModal({ create: true })}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'var(--paper)', color: 'var(--ink)',
              border: '1px solid var(--rule)', borderRadius: 9, cursor: 'pointer',
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
                draggable={canManage}
                onDragStart={canManage ? (e) => {
                  e.dataTransfer.setData(FOLDER_DRAG_MIME, f.id)
                  e.dataTransfer.effectAllowed = 'move'
                  setDragFolderId(f.id)
                } : undefined}
                onDragEnd={() => setDragFolderId(null)}
                onDragOver={dragOver(f.id)} onDragLeave={dragLeave(f.id)} onDrop={handleDrop(f.id)}
                style={{
                  position: 'relative',
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px',
                  background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  cursor: 'pointer',
                  ...dropTargetStyle(f.id),
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
                      background: 'var(--paper)', border: '1px solid var(--rule)',
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
                          color: item.danger ? 'var(--down)' : 'var(--ink-2)',
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
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
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
            background: 'var(--paper)', border: '1px solid var(--rule)', outline: 'none',
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
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
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
