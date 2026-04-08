import type { ApplicationStatus } from '@prisma/client'

export const ADMIN_TARGET_STATUSES: ApplicationStatus[] = ['UNDER_REVIEW', 'INTERVIEW', 'APPROVED', 'REJECTED']

const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DRAFT: ['UNDER_REVIEW', 'REJECTED'],
  SUBMITTED: ['UNDER_REVIEW', 'REJECTED', 'INTERVIEW'],
  UNDER_REVIEW: ['INTERVIEW', 'APPROVED', 'REJECTED'],
  INTERVIEW: ['UNDER_REVIEW', 'APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: ['UNDER_REVIEW']
}

export function canTransitionApplicationStatus(from: ApplicationStatus, to: ApplicationStatus) {
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function appendAdminStatusNote(existingNotes: string | null, input: { adminId: string; status: ApplicationStatus; reason?: string }) {
  const stamp = new Date().toISOString()
  const base = `[${stamp}] admin=${input.adminId} status=${input.status}`
  const reasonPart = input.reason?.trim() ? ` reason="${input.reason.trim()}"` : ''
  const line = `${base}${reasonPart}`
  if (!existingNotes?.trim()) return line
  return `${existingNotes.trim()}\n${line}`
}
