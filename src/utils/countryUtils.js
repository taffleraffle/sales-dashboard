export function getCountry(phone, email) {
  if (phone?.startsWith('+64') || email?.endsWith('.nz'))
    return { code: 'NZ', flag: '\u{1F1F3}\u{1F1FF}' }
  if (phone?.startsWith('+61') || email?.endsWith('.au') || email?.endsWith('.com.au'))
    return { code: 'AU', flag: '\u{1F1E6}\u{1F1FA}' }
  if (phone?.startsWith('+44') || email?.endsWith('.uk') || email?.endsWith('.co.uk'))
    return { code: 'UK', flag: '\u{1F1EC}\u{1F1E7}' }
  if (phone?.startsWith('+1'))
    return { code: 'US', flag: '\u{1F1FA}\u{1F1F8}' }
  return { code: '—', flag: '\u{1F310}' }
}
