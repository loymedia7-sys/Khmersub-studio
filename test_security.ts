import fs from 'fs';
import path from 'path';
import {
  findProjectVideoFile,
  resolveExportFilePath,
  verifyProjectOwnership,
  isValidIdentifier,
  isValidFileName,
} from './server';
import { UPLOADS_DIR, EXPORTS_DIR } from './server/services/media.service';

async function runSecurityTests() {
  console.log('====================================================');
  console.log('   RUNNING COMPREHENSIVE BACKEND SECURITY TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // Set up mock directory structures for User A and User B
  const userA = 'user_alice_123';
  const userB = 'user_bob_456';
  const projA = 'proj_alice_video';
  const projB = 'proj_bob_secret';

  const userADir = path.join(UPLOADS_DIR, userA, projA);
  const userBDir = path.join(UPLOADS_DIR, userB, projB);
  const userBExportDir = path.join(EXPORTS_DIR, userB, projB);

  fs.mkdirSync(userADir, { recursive: true });
  fs.mkdirSync(userBDir, { recursive: true });
  fs.mkdirSync(userBExportDir, { recursive: true });

  fs.writeFileSync(path.join(userADir, 'video.mp4'), 'Alice Video Content');
  fs.writeFileSync(
    path.join(userADir, 'project.json'),
    JSON.stringify({ projectId: projA, ownerId: userA, title: 'Alice Project' })
  );

  fs.writeFileSync(path.join(userBDir, 'video.mp4'), 'Bob Secret Video Content');
  fs.writeFileSync(
    path.join(userBDir, 'project.json'),
    JSON.stringify({ projectId: projB, ownerId: userB, title: 'Bob Confidential' })
  );

  fs.writeFileSync(path.join(userBExportDir, 'subs.srt'), '1\n00:00:01 --> 00:00:04\nBob confidential subtitles');
  fs.writeFileSync(path.join(userBExportDir, 'burned.mp4'), 'Bob Burned MP4 Video');

  // TEST SUITE 1: Identifier & File Name Validation
  console.log('\n--- 1. Identifier & File Name Validation ---');
  assert('Valid alphanumeric UID', isValidIdentifier(userA));
  assert('Valid project ID with underscores and hyphens', isValidIdentifier('proj-123_abc'));
  assert('Reject empty identifier', !isValidIdentifier(''));
  assert('Reject identifier with path traversal ../', !isValidIdentifier('../userB'));
  assert('Reject identifier with slashes /', !isValidIdentifier('user/bob'));
  assert('Reject identifier with null bytes', !isValidIdentifier('user\0bob'));
  assert('Reject identifier with special symbols', !isValidIdentifier('user$*#'));

  assert('Valid file name video.mp4', isValidFileName('video.mp4'));
  assert('Valid file name subs.srt', isValidFileName('subs.srt'));
  assert('Reject traversal file name ../../etc/passwd', !isValidFileName('../../etc/passwd'));
  assert('Reject file name with backslashes', !isValidFileName('..\\secret.mp4'));
  assert('Reject file name with null bytes', !isValidFileName('video.mp4\0.jpg'));

  // TEST SUITE 2: Cross-User File Access (User A accessing User B's files)
  console.log('\n--- 2. Cross-User File Isolation ---');
  // User A should find their own video
  const aliceOwnVideo = findProjectVideoFile(userA, projA);
  assert('User A finds own video file', aliceOwnVideo !== null && aliceOwnVideo.includes(userA));

  // User A attempting to find User B's video file
  const aliceAccessBobVideo = findProjectVideoFile(userA, projB);
  assert(
    'User A CANNOT access User B\'s video file (returns null)',
    aliceAccessBobVideo === null,
    aliceAccessBobVideo || ''
  );

  // User A attempting to resolve User B's export
  const aliceAccessBobExportSrt = resolveExportFilePath(userA, projB, 'srt');
  assert(
    'User A CANNOT access User B\'s SRT export (returns null)',
    aliceAccessBobExportSrt === null,
    aliceAccessBobExportSrt || ''
  );

  const aliceAccessBobExportBurn = resolveExportFilePath(userA, projB, 'burn');
  assert(
    'User A CANNOT access User B\'s burned MP4 export (returns null)',
    aliceAccessBobExportBurn === null,
    aliceAccessBobExportBurn || ''
  );

  // TEST SUITE 3: Project Ownership Verification Against Database
  console.log('\n--- 3. Database Project Ownership Verification ---');
  const checkAliceOwn = await verifyProjectOwnership(userA, projA);
  assert('Alice is verified owner of Project A', checkAliceOwn.isOwner === true);

  const checkAliceOnBobProj = await verifyProjectOwnership(userA, projB);
  assert(
    'Alice is NOT owner of Bob\'s Project B (isOwner: false)',
    checkAliceOnBobProj.isOwner === false
  );
  assert(
    'Server detects Bob\'s Project exists under another user (exists: true, triggers 403 Forbidden)',
    checkAliceOnBobProj.exists === true && checkAliceOnBobProj.actualOwnerId === userB
  );

  const checkNonExistent = await verifyProjectOwnership(userA, 'proj_does_not_exist_xyz');
  assert(
    'Non-existent project is identified (isOwner: false, exists: false, triggers 404 Not Found)',
    checkNonExistent.isOwner === false && checkNonExistent.exists === false
  );

  // TEST SUITE 4: Directory Traversal Attacks Prevention
  console.log('\n--- 4. Directory Traversal Attack Defense ---');
  const traversalVideo1 = findProjectVideoFile(userA, `../../${userB}/${projB}`);
  assert('Traversal via ../../ rejected by findProjectVideoFile', traversalVideo1 === null);

  const traversalExport1 = resolveExportFilePath(userA, `../../${userB}/${projB}`, 'burn');
  assert('Traversal via ../../ rejected by resolveExportFilePath', traversalExport1 === null);

  const traversalUid = findProjectVideoFile(`../${userB}`, projB);
  assert('Traversal in UID rejected by findProjectVideoFile', traversalUid === null);

  // Cleanup test mock files
  try {
    fs.rmSync(path.join(UPLOADS_DIR, userA), { recursive: true, force: true });
    fs.rmSync(path.join(UPLOADS_DIR, userB), { recursive: true, force: true });
    fs.rmSync(path.join(EXPORTS_DIR, userB), { recursive: true, force: true });
  } catch {
    // cleanup
  }

  console.log('\n====================================================');
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
