import { useRef, useState } from 'react'
import { Upload, Mic, Check, AlertCircle, Loader } from 'lucide-react'
import { uploadAndTranscribeAdVideo } from '../../services/adAnalyst'
import { useToast } from '../../hooks/useToast'

/*
  Upload-source-video button overlay for AdCard.
  Clicking opens a file picker. Picking a video uploads to
  ad-source-videos bucket and fires the Whisper Edge Function.
  Stops propagation so the parent Link doesn't navigate.

  Visual states:
    idle    → mic icon
    uploading → spinner
    success → check (auto-clears after 5s)
    error   → alert (auto-clears after 8s)

  Only shown for ads whose hasTranscript === false (so we don't re-upload
  over an existing transcript).
*/

export default function AdCardUploadButton({ adId, alreadyTranscribed }) {
  const fileRef = useRef(null)
  const [state, setState] = useState('idle')   // idle | uploading | success | error
  const [errMsg, setErrMsg] = useState('')
  const toast = useToast()

  const onPick = (e) => {
    e.stopPropagation()
    e.preventDefault()
    fileRef.current?.click()
  }

  const onFile = async (e) => {
    e.stopPropagation()
    const file = e.target.files?.[0]
    if (!file) return
    setState('uploading')
    try {
      const result = await uploadAndTranscribeAdVideo(adId, file)
      setState('success')
      toast.success(
        `Transcribed · ${result.duration_sec}s · ${result.full_length} chars`,
        { duration: 5000 }
      )
      setTimeout(() => setState('idle'), 5000)
    } catch (err) {
      console.error('[upload-transcribe]', adId, err)
      setErrMsg(err.message)
      setState('error')
      toast.error(`Transcribe failed: ${err.message}`, { duration: 8000 })
      setTimeout(() => setState('idle'), 8000)
    } finally {
      // Reset input so the same file can be re-picked
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const baseStyle = {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 3,
    border: '1px solid var(--rule)',
    background: alreadyTranscribed ? 'var(--up-soft)' : 'rgba(10,10,10,0.7)',
    color: alreadyTranscribed ? 'var(--up)' : 'var(--paper)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: state === 'uploading' ? 'wait' : 'pointer',
    transition: 'background 160ms ease',
    zIndex: 10,
  }

  let icon
  let title
  if (state === 'uploading') {
    icon = <Loader size={13} className="animate-spin" />
    title = 'Uploading + transcribing…'
  } else if (state === 'success') {
    icon = <Check size={13} />
    title = 'Transcribed successfully'
  } else if (state === 'error') {
    icon = <AlertCircle size={13} />
    title = `Transcribe failed: ${errMsg}`
  } else if (alreadyTranscribed) {
    icon = <Mic size={13} />
    title = 'Already transcribed — click to re-upload'
  } else {
    icon = <Upload size={13} />
    title = 'Upload source MP4 to transcribe this ad'
  }

  return (
    <>
      <button
        onClick={onPick}
        disabled={state === 'uploading'}
        style={baseStyle}
        title={title}
        aria-label={title}
      >
        {icon}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        onChange={onFile}
        onClick={e => e.stopPropagation()}
        style={{ display: 'none' }}
      />
    </>
  )
}
