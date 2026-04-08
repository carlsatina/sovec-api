export function normalizePhoneForIdentity(phone: string) {
  const raw = phone.trim()
  const digits = raw.replace(/[^\d]/g, '')

  // PH mobile: 09XXXXXXXXX
  if (digits.startsWith('0') && digits.length === 11) {
    return `+63${digits.slice(1)}`
  }
  // PH mobile: 63XXXXXXXXXX
  if (digits.startsWith('63') && digits.length === 12) {
    return `+${digits}`
  }
  // PH mobile: 9XXXXXXXXX
  if (digits.startsWith('9') && digits.length === 10) {
    return `+63${digits}`
  }

  if (raw.startsWith('+')) {
    return `+${digits}`
  }
  return raw
}

export function toSemaphoreNumber(phone: string) {
  const normalized = normalizePhoneForIdentity(phone)
  const digits = normalized.replace(/[^\d]/g, '')
  if (digits.startsWith('63')) return digits
  if (digits.startsWith('0')) return `63${digits.slice(1)}`
  return digits
}
