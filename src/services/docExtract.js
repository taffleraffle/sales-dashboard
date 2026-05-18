/*
  Extract plain text from common script document formats. Used by the
  "Paste transcript" tab to let operators drop a script .pdf / .docx /
  .txt / .md instead of pasting raw text.

  All three formats are handled client-side:
   - .txt / .md       → FileReader (built-in)
   - .pdf             → pdfjs-dist (lazy-loaded)
   - .docx            → mammoth.js (lazy-loaded)

  Returns a clean text string ready to insert into the textarea.
*/

const SUPPORTED_EXTS = ['txt', 'md', 'markdown', 'pdf', 'docx']

export function isSupportedDocFile(file) {
  if (!file) return false
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  return SUPPORTED_EXTS.includes(ext)
}

export function getSupportedExtensionsLabel() {
  return SUPPORTED_EXTS.map(e => '.' + e).join(', ')
}

/**
 * Extract text from a script document file.
 *
 * @param {File} file
 * @param {object} opts
 * @param {(stage: string) => void} [opts.onProgress]
 * @returns {Promise<{ text: string, sourceFormat: string, wordCount: number }>}
 */
export async function extractTextFromFile(file, { onProgress } = {}) {
  if (!file) throw new Error('extractTextFromFile: file required')
  const ext = (file.name.split('.').pop() || '').toLowerCase()

  let text = ''
  let sourceFormat = ext

  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    onProgress?.('Reading text file…')
    text = await readAsText(file)
    sourceFormat = ext === 'markdown' ? 'md' : ext
  } else if (ext === 'pdf') {
    onProgress?.('Loading PDF reader…')
    text = await extractFromPdf(file, onProgress)
  } else if (ext === 'docx') {
    onProgress?.('Loading docx reader…')
    text = await extractFromDocx(file, onProgress)
  } else {
    throw new Error(`Unsupported file type ".${ext}". Supported: ${getSupportedExtensionsLabel()}`)
  }

  const clean = normalize(text)
  return {
    text: clean,
    sourceFormat,
    wordCount: clean.trim().split(/\s+/).filter(Boolean).length,
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file, 'utf-8')
  })
}

async function extractFromPdf(file, onProgress) {
  // pdfjs-dist is ~1MB. Lazy-loaded so it never bloats the Insights bundle.
  const pdfjs = await import('pdfjs-dist')
  // pdfjs needs a worker. Use the CDN-hosted worker matching our version.
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

  onProgress?.('Parsing PDF…')
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(`Extracting page ${i} of ${pdf.numPages}…`)
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map(it => it.str).join(' ')
    pages.push(text)
  }
  return pages.join('\n\n')
}

async function extractFromDocx(file, onProgress) {
  // mammoth is ~600KB. Lazy-loaded.
  const mammoth = await import('mammoth')
  onProgress?.('Parsing docx…')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value || ''
}

function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')        // Windows → Unix line endings
    .replace(/ /g, ' ')       // non-breaking spaces → regular spaces
    .replace(/[ \t]+\n/g, '\n')    // trailing whitespace on each line
    .replace(/\n{3,}/g, '\n\n')    // collapse 3+ newlines to 2
    .trim()
}
