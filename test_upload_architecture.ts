import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  createUploadSession,
  getUploadSession,
  storeChunk,
  completeUploadSession,
  cancelUploadSession,
  validateMediaContent,
  STAGING_DIR,
} from './server/services/upload.service';
import { UPLOADS_DIR } from './server/services/media.service';

const execFileAsync = promisify(execFile);

async function runUploadArchitectureTests() {
  console.log('🧪 Starting Upload Architecture Security & Integrity Tests...');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // 1. Create session validation
  console.log('\n--- 1. Upload Session Creation & Validation ---');
  try {
    const session = createUploadSession({
      uid: 'user_alice',
      projectId: 'proj_test_101',
      fileName: 'raw_video.mp4',
      expectedSizeBytes: 10 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
      totalChunks: 3, // ceil(10 / 4) = 3
    });
    assert(Boolean(session.uploadId), 'Session created with unique uploadId');
    assert(session.totalChunks === 3, 'Total chunks calculated and verified');
    assert(fs.existsSync(session.stagingDir), 'Staging directory created on disk');
  } catch (e: any) {
    assert(false, `Session creation failed unexpectedly: ${e.message}`);
  }

  // 2. Reject total chunks mismatch
  try {
    createUploadSession({
      uid: 'user_alice',
      projectId: 'proj_test_102',
      fileName: 'raw_video.mp4',
      expectedSizeBytes: 10 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
      totalChunks: 5, // Expected is 3
    });
    assert(false, 'Should reject mismatched totalChunks');
  } catch (e: any) {
    assert(e.message.includes('Total chunks mismatch'), 'Rejects total chunks mismatch');
  }

  // 3. Reject invalid identifiers / traversal in session creation
  try {
    createUploadSession({
      uid: '../etc',
      projectId: 'proj_103',
      fileName: 'video.mp4',
      expectedSizeBytes: 1000,
      chunkSize: 1000,
      totalChunks: 1,
    });
    assert(false, 'Should reject path traversal UID');
  } catch (e: any) {
    assert(e.message.includes('Invalid user identifier'), 'Rejects malicious traversal UID');
  }

  // 4. Duplicate chunk detection (Task 4: Reject duplicate chunks with 409)
  console.log('\n--- 2. Chunk Ingestion & Duplicate Protection ---');
  const session2 = createUploadSession({
    uid: 'user_alice',
    projectId: 'proj_test_dup',
    fileName: 'clip.mp4',
    expectedSizeBytes: 600,
    chunkSize: 200,
    totalChunks: 3,
  });

  const chunk0 = Buffer.alloc(200, 'A');
  await storeChunk({
    uploadId: session2.uploadId,
    uid: 'user_alice',
    chunkIndex: 0,
    chunkBuffer: chunk0,
  });
  assert(session2.receivedChunks.has(0), 'Chunk 0 stored successfully');

  try {
    // Attempt duplicate chunk 0
    await storeChunk({
      uploadId: session2.uploadId,
      uid: 'user_alice',
      chunkIndex: 0,
      chunkBuffer: chunk0,
    });
    assert(false, 'Should reject duplicate chunk 0');
  } catch (e: any) {
    assert(e.statusCode === 409, 'Duplicate chunk rejected with HTTP 409');
  }

  // 5. Out-of-bounds chunk index (Task 3: Validate chunk indexes)
  try {
    await storeChunk({
      uploadId: session2.uploadId,
      uid: 'user_alice',
      chunkIndex: 99,
      chunkBuffer: Buffer.alloc(10),
    });
    assert(false, 'Should reject out-of-bounds chunk index 99');
  } catch (e: any) {
    assert(e.statusCode === 400, 'Out-of-bounds chunk index rejected with HTTP 400');
  }

  // 6. Cross-user session access prevention (Task 13)
  console.log('\n--- 3. Cross-Tenant Session Isolation ---');
  try {
    // User Bob tries to store a chunk in Alice's session
    await storeChunk({
      uploadId: session2.uploadId,
      uid: 'user_bob',
      chunkIndex: 1,
      chunkBuffer: Buffer.alloc(200, 'B'),
    });
    assert(false, 'User Bob should not be able to write to Alice session');
  } catch (e: any) {
    assert(e.statusCode === 403, 'Cross-user chunk upload rejected with HTTP 403 Forbidden');
  }

  try {
    // User Bob tries to complete Alice's session
    await completeUploadSession(session2.uploadId, 'user_bob');
    assert(false, 'User Bob should not be able to complete Alice session');
  } catch (e: any) {
    assert(e.statusCode === 403, 'Cross-user complete session rejected with HTTP 403 Forbidden');
  }

  // 7. Missing chunks on completion (Task 5: Reject missing chunks)
  console.log('\n--- 4. Missing Chunks & Total Size Validation ---');
  try {
    // Only chunk 0 is uploaded, chunks 1 & 2 are missing
    await completeUploadSession(session2.uploadId, 'user_alice');
    assert(false, 'Should reject completion when chunks are missing');
  } catch (e: any) {
    assert(e.statusCode === 400, 'Incomplete upload rejected with HTTP 400');
    assert(Array.isArray(e.missingChunks) && e.missingChunks.includes(1) && e.missingChunks.includes(2), 'Missing chunk indexes reported correctly');
  }

  // 8. Upload Cancellation & Staging Cleanup (Task 8 & 12)
  console.log('\n--- 5. Upload Cancellation & Cleanup ---');
  const cancelSession = createUploadSession({
    uid: 'user_alice',
    projectId: 'proj_cancel_test',
    fileName: 'cancelled.mp4',
    expectedSizeBytes: 800,
    chunkSize: 400,
    totalChunks: 2,
  });
  await storeChunk({
    uploadId: cancelSession.uploadId,
    uid: 'user_alice',
    chunkIndex: 0,
    chunkBuffer: Buffer.alloc(400, 'X'),
  });
  assert(fs.existsSync(cancelSession.stagingDir), 'Staging directory exists before cancellation');

  const cancelRes = await cancelUploadSession(cancelSession.uploadId, 'user_alice');
  assert(cancelRes.cancelled === true, 'cancelUploadSession returns cancelled: true');
  assert(!fs.existsSync(cancelSession.stagingDir), 'Staging directory completely deleted upon cancellation');

  // 9. Media Content Validation using ffprobe & Magic Bytes (Task 7)
  console.log('\n--- 6. Media Format Inspection via Content (Not File Extension) ---');
  const fakeVideoPath = path.resolve(STAGING_DIR, 'fake_text_masquerading_as_video.mp4');
  fs.writeFileSync(fakeVideoPath, 'This is fake plain text file disguised with .mp4 extension');

  const fakeCheck = await validateMediaContent(fakeVideoPath);
  assert(fakeCheck.isValid === false, 'Fake plain text file disguised as .mp4 correctly rejected');
  fs.unlinkSync(fakeVideoPath);

  // Generate a real 1-second sample video using ffmpeg
  const realVideoPath = path.resolve(STAGING_DIR, 'test_real_sample.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=navy:s=320x240:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    realVideoPath,
  ]);

  const realCheck = await validateMediaContent(realVideoPath);
  assert(realCheck.isValid === true && realCheck.mimeType === 'video/mp4', 'Real MP4 validated by ffprobe streams & container header');

  // 10. End-to-end chunked upload, assembly via streams (Task 14), and final file verification (Task 11)
  console.log('\n--- 7. End-to-End Large File Multipart Upload & Stream Assembly ---');
  const realVideoBuf = fs.readFileSync(realVideoPath);
  const totalRealSize = realVideoBuf.length;
  const CHUNK_SIZE = Math.ceil(totalRealSize / 3);
  const totalExpectedChunks = Math.ceil(totalRealSize / CHUNK_SIZE);

  const e2eSession = createUploadSession({
    uid: 'user_alice',
    projectId: 'proj_e2e_verified',
    fileName: 'real_video.mp4',
    expectedSizeBytes: totalRealSize,
    chunkSize: CHUNK_SIZE,
    totalChunks: totalExpectedChunks,
  });

  for (let i = 0; i < totalExpectedChunks; i++) {
    const slice = realVideoBuf.slice(i * CHUNK_SIZE, Math.min(totalRealSize, (i + 1) * CHUNK_SIZE));
    await storeChunk({
      uploadId: e2eSession.uploadId,
      uid: 'user_alice',
      chunkIndex: i,
      chunkBuffer: slice,
    });
  }

  const completed = await completeUploadSession(e2eSession.uploadId, 'user_alice');
  assert(completed.projectId === 'proj_e2e_verified', 'Session completed with correct project ID');
  assert(completed.sizeBytes === totalRealSize, 'Assembled file size matches expected size exactly');
  assert(fs.existsSync(completed.videoFilePath), 'Final video exists at user-isolated destination');
  assert(!fs.existsSync(e2eSession.stagingDir), 'Staging parts removed after successful assembly');

  // Clean up test file
  if (fs.existsSync(realVideoPath)) fs.unlinkSync(realVideoPath);

  console.log(`\n========================================`);
  console.log(`Upload Architecture Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runUploadArchitectureTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
