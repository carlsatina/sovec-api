import test from 'node:test'
import assert from 'node:assert/strict'
import { appendAdminStatusNote, canTransitionApplicationStatus } from './admin-driver-applications.js'

test('canTransitionApplicationStatus enforces workflow', () => {
  assert.equal(canTransitionApplicationStatus('SUBMITTED', 'UNDER_REVIEW'), true)
  assert.equal(canTransitionApplicationStatus('UNDER_REVIEW', 'APPROVED'), true)
  assert.equal(canTransitionApplicationStatus('APPROVED', 'REJECTED'), false)
  assert.equal(canTransitionApplicationStatus('REJECTED', 'UNDER_REVIEW'), true)
  assert.equal(canTransitionApplicationStatus('DRAFT', 'APPROVED'), false)
})

test('appendAdminStatusNote appends structured admin note lines', () => {
  const note1 = appendAdminStatusNote(null, {
    adminId: 'admin-1',
    status: 'REJECTED',
    reason: 'Documents incomplete'
  })
  assert.equal(note1.includes('admin=admin-1'), true)
  assert.equal(note1.includes('status=REJECTED'), true)
  assert.equal(note1.includes('Documents incomplete'), true)

  const note2 = appendAdminStatusNote(note1, {
    adminId: 'admin-2',
    status: 'UNDER_REVIEW'
  })
  assert.equal(note2.split('\n').length, 2)
  assert.equal(note2.includes('admin=admin-2'), true)
})
