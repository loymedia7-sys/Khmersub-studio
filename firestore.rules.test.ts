/**
 * Security Rules Verification Suite for Khmersub Studio
 * Verifies that all 12 "Dirty Dozen" adversarial payloads return PERMISSION_DENIED.
 */

export interface SecurityPayloadTest {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityPayloadTest[] = [
  {
    id: 1,
    name: 'Unverified Email Spoof',
    collectionPath: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'spoof@example.com', email_verified: false },
    payload: {
      uid: 'user_1',
      displayName: 'Spoofer',
      email: 'spoof@example.com',
      plan: 'free',
      minutesTranscribed: 0,
      minutesLimit: 60,
      periodStart: '2026-10-01T00:00:00Z',
      defaultLanguage: 'km+en',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'PII Cross-Tenant Read',
    collectionPath: '/users/victim_uid',
    operation: 'get',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Project Create',
    collectionPath: '/projects/proj_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'user_1',
      title: 'Test Video',
      isAdmin: true,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-Tenant Project Ownership Spoof',
    collectionPath: '/projects/proj_1',
    operation: 'create',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      ownerId: 'victim_uid',
      title: 'Spoofed Project',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Immutable Field Mutation (ownerId Flip)',
    collectionPath: '/projects/proj_1',
    operation: 'update',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'user_2',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Timestamp Forgery (Temporal Integrity Violation)',
    collectionPath: '/projects/proj_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'user_1',
      title: 'Forged Time',
      createdAt: '2020-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Denial-of-Wallet Oversized String',
    collectionPath: '/projects/proj_1/segments/seg_1',
    operation: 'update',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      text: 'A'.repeat(5000),
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Orphaned Subcollection Write',
    collectionPath: '/projects/nonexistent_proj/segments/seg_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'user_1',
      projectId: 'nonexistent_proj',
      index: 0,
      start: 0,
      end: 2,
      text: 'Hello',
      originalText: 'Hello',
      speaker: 'Speaker 1',
      lang: 'en',
      confidence: 0.9,
      edited: false,
      editedBy: '',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Cross-Tenant Subcollection Write (Master Gate Breach)',
    collectionPath: '/projects/victim_proj/segments/seg_1',
    operation: 'update',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      text: 'Tampered subtitle',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Unbounded Tag Array Attack',
    collectionPath: '/projects/proj_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'user_1',
      tags: Array.from({ length: 25 }, (_, i) => `tag_${i}`),
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Value Poisoning on Update',
    collectionPath: '/projects/proj_1',
    operation: 'update',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      status: 'hacked_status',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized Template Mutation',
    collectionPath: '/templates/tpl_1',
    operation: 'update',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      name: 'Hijacked Template',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
];
