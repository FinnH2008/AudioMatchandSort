import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCodecQuality,
  detectPathCollisions,
  isWavCodec,
  sanitizeRelativePath,
} from './codecAndSanitizer';
import {
  buildArtistClusters,
  extractCanonicalAlbumArtist,
} from './artistDedupe';
import {
  compareDuplicateCandidates,
  computeNextModeAction,
  evaluateLibraryPlan,
  isCompilationAlbumGroup,
  selectBestAlbumRelease,
} from './classifierAndPlanner';
import {
  createSeedCompanions,
  createSeedLeftovers,
  createSeedTracks,
  DEFAULT_CONFIG,
} from '../data/seedLibrary';
import { generateDockerBundle } from './dockerGenerator';

test('Codec classification distinguishes M4A ALAC (lossless) vs M4A AAC (lossy)', () => {
  assert.equal(classifyCodecQuality('alac', 1060, 256, true), 'lossless');
  assert.equal(classifyCodecQuality('aac', 256, 256, true), 'lossy_high');
  assert.equal(classifyCodecQuality('aac', 128, 256, true), 'lossy_low');
  assert.equal(classifyCodecQuality('pcm_s16le', 1411, 256, true), 'lossless');
  assert.equal(isWavCodec('pcm_s16le', '.wav'), true);
});

test('SMB path sanitizer cleans illegal characters and flags case-insensitive collisions without overwriting', () => {
  const san = sanitizeRelativePath(['Lossless', 'AC/DC?'], '01: Back*In Black...', '.flac', 240);
  assert.equal(san.changed, true);
  assert.equal(san.relativePath, 'Lossless/AC_DC_/01_ Back_In Black.flac');

  const collisions = detectPathCollisions(
    [
      { id: 'a', targetRelativePath: 'Lossless/Daft Punk/01 Track.flac', tooLong: false },
      { id: 'b', targetRelativePath: 'Lossless/daft punk/01 track.flac', tooLong: false },
    ],
    true
  );
  assert.equal(collisions.get('a')?.type, 'none');
  assert.equal(collisions.get('b')?.type, 'smb_case_collision');
});

test('MBID-protected bands with &, comma, or vs. are NEVER split, while feat. IS stripped', () => {
  assert.equal(
    extractCanonicalAlbumArtist('Simon & Garfunkel', null, false).canonical,
    'Simon & Garfunkel'
  );
  assert.equal(
    extractCanonicalAlbumArtist('Earth, Wind & Fire', null, false).canonical,
    'Earth, Wind & Fire'
  );
  assert.equal(
    extractCanonicalAlbumArtist('Tyler, The Creator', null, false).canonical,
    'Tyler, The Creator'
  );
  assert.equal(
    extractCanonicalAlbumArtist('Years & Years', null, false).canonical,
    'Years & Years'
  );
  assert.equal(
    extractCanonicalAlbumArtist('Daft Punk feat. Pharrell Williams', null, false).canonical,
    'Daft Punk'
  );
});

test('Artist deduplication auto-merges MBID/exact normalization but keeps Fuzzy strictly needs_review', () => {
  const tracks = createSeedTracks();
  const { clusters } = buildArtistClusters(tracks);

  const fuzzyClusters = clusters.filter((c) => c.rule === 'fuzzy_suggestion');
  assert.ok(fuzzyClusters.length >= 2, 'Expected fuzzy clusters for Tiësto/DJ Tiesto and Fred again../Fred Again');
  for (const fc of fuzzyClusters) {
    assert.equal(fc.status, 'needs_review');
  }

  const royksopp = clusters.find((c) => c.canonicalName === 'Röyksopp');
  assert.ok(royksopp);
  assert.equal(royksopp.status, 'auto_resolved');
});

test('Album-aware duplicates separate true duplicates (_Duplikate) from cross-album notices (Auch auf Album X)', () => {
  const tracks = createSeedTracks();
  const res = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  // One More Time on Bravo Hits must be a cross_album_notice, NOT moved to _Duplikate
  const bravoTrackPlan = res.trackPlans.get('trk-06')!;
  assert.equal(bravoTrackPlan.isDuplicateToMove, false);
  assert.ok(bravoTrackPlan.targetRelativePath.startsWith('Lossy/Various Artists/2024 - Bravo Hits 124/'));

  const crossNotices = res.duplicateGroups.filter((g) => g.scope === 'cross_album_notice');
  assert.ok(crossNotices.length >= 1);
  assert.ok(crossNotices[0].crossAlbumNote?.includes('Auch auf Album'));

  // Loose 128k MP3 of One More Time (trk-04) & 16-bit FLAC copy (trk-03) move to _Duplikate
  assert.equal(res.trackPlans.get('trk-03')?.isDuplicateToMove, true);
  assert.equal(res.trackPlans.get('trk-04')?.isDuplicateToMove, true);
  assert.ok(res.trackPlans.get('trk-04')?.targetRelativePath.startsWith('_Duplikate/Daft Punk/'));

  // DJ-Remix of Delilah (trk-17) is NEVER marked duplicate of original Delilah (trk-16)
  assert.equal(res.trackPlans.get('trk-17')?.isDuplicateToMove, false);
  assert.equal(res.trackPlans.get('trk-17')?.classification, 'dj_remix');
});

test('Duplicate tiebreaker order: higher quality -> more complete tags -> larger size -> older mtime', () => {
  const tracks = createSeedTracks();
  const epleRich = tracks.find((t) => t.id === 'trk-07')!;
  const epleSparse = tracks.find((t) => t.id === 'trk-08')!;
  const cmp = compareDuplicateCandidates(epleRich, epleSparse);
  assert.equal(cmp.winner.id, 'trk-07');
  assert.equal(cmp.reason, 'more_complete_tags');
});

test('Official album remixes & whole remix albums stay in album, while non-tracklist bootlegs detach to DJ-Remixes', () => {
  const tracks = createSeedTracks();
  const res = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  // Official remix on Discovery tracklist (trk-02) stays album_track
  assert.equal(res.trackPlans.get('trk-02')?.classification, 'album_track');
  assert.ok(res.trackPlans.get('trk-02')?.targetRelativePath.startsWith('Lossless/Daft Punk/2001 - Discovery/'));

  // Whole remix album Dua Lipa (trk-13) stays album_track
  assert.equal(res.trackPlans.get('trk-13')?.classification, 'album_track');

  // Foreign bootleg in Discovery folder (trk-05) detaches to DJ-Remixes/ (Option A default)
  assert.equal(res.trackPlans.get('trk-05')?.classification, 'dj_remix');
  assert.ok(res.trackPlans.get('trk-05')?.targetRelativePath.startsWith('DJ-Remixes/'));

  // Option B splits DJ-Remixes into Lossless/DJ-Remixes and Lossy/DJ-Remixes
  const resOptionB = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    { ...DEFAULT_CONFIG, djRemixLayout: 'split_by_quality' },
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.ok(resOptionB.trackPlans.get('trk-05')?.targetRelativePath.startsWith('Lossy/DJ-Remixes/'));
});

test('Quality-split _Review/Lossless and _Review/Lossy routing plus keepReviewTracksInPlace option', () => {
  const tracks = createSeedTracks();
  const res = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  // trk-18 is Lossless review -> _Review/Lossless/{origRelPath}
  assert.equal(
    res.trackPlans.get('trk-18')?.targetRelativePath,
    '_Review/Lossless/private_vinyl_rips/Analog_Tape_Sessions/01 Nocturne in C Minor.flac'
  );
  // trk-19 is Lossy review (no remix keyword, 62% confidence) -> _Review/Lossy/{origRelPath}
  assert.equal(
    res.trackPlans.get('trk-19')?.targetRelativePath,
    '_Review/Lossy/eingemischt_mp3s/Unbekannt_2018/Track07_Midnight_Drive.ogg'
  );
  assert.equal(res.report.reviewLosslessCount, 1);
  assert.equal(res.report.reviewLossyCount, 1);

  // Checkbox keepReviewTracksInPlace leaves both untouched
  const resKeep = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    { ...DEFAULT_CONFIG, keepReviewTracksInPlace: true },
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.equal(
    resKeep.trackPlans.get('trk-18')?.targetRelativePath,
    tracks.find((t) => t.id === 'trk-18')?.sourceRelativePath
  );
});

test('Fake-FLAC spectral warning never demotes Lossless track, and WAV media embedding defaults OFF', () => {
  const tracks = createSeedTracks();
  const res = evaluateLibraryPlan(
    tracks,
    createSeedCompanions(),
    createSeedLeftovers(),
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  // trk-09 has spectralWarningOnly=true -> stays in Lossless/
  assert.ok(res.trackPlans.get('trk-09')?.targetRelativePath.startsWith('Lossless/Simon & Garfunkel/'));
  assert.equal(res.report.fakeFlacWarningCount, 1);
  // trk-10 is WAV -> wavMediaSkipped=true by default
  assert.equal(res.trackPlans.get('trk-10')?.wavMediaSkipped, true);
});

test('3-Mode Gate: Mode 2 unlocks even with open artist conflicts, Mode 3 requires 0 conflicts, Re-Run activates after Mode 3', () => {
  const m1 = computeNextModeAction({
    mode1Completed: false,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 2,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
  });
  assert.equal(m1.mode, 'analyze');
  assert.equal(m1.enabled, true);

  // Mode 2 is ENABLED even with 2 open artist conflicts (those tracks are skipped)
  const m2 = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 2,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
  });
  assert.equal(m2.mode, 'tag');
  assert.equal(m2.enabled, true);

  // Mode 3 is BLOCKED until 0 open artist conflicts
  const m3Blocked = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: true,
    mode3Completed: false,
    openArtistConflictCount: 2,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
  });
  assert.equal(m3Blocked.mode, 'move');
  assert.equal(m3Blocked.enabled, false);

  // Re-Run activates after Mode 3 when review tracks are manually reassigned
  const rerun = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: true,
    mode3Completed: true,
    openArtistConflictCount: 0,
    pathCollisionCount: 0,
    pendingReRunCount: 1,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
  });
  assert.equal(rerun.mode, 'rerun');
  assert.equal(rerun.enabled, true);
});

test('Compilation release matcher searches exclusively compilation releases and Docker bundle contains required sections', () => {
  const tracks = createSeedTracks();
  const bravoTrack = tracks.find((t) => t.id === 'trk-06')!;
  assert.equal(isCompilationAlbumGroup('Bravo Hits 124', [bravoTrack]), true);
  const picked = selectBestAlbumRelease('Bravo Hits 124', [bravoTrack], [
    {
      releaseId: 'studio',
      title: 'Discovery',
      albumArtist: 'Daft Punk',
      year: '2001',
      country: 'EU',
      format: 'CD',
      trackCount: 14,
      isCompilation: false,
      isRemixAlbum: false,
      matchScore: 0.99,
      tracklist: [],
    },
    bravoTrack.matchedRelease!,
  ]);
  assert.equal(picked?.isCompilation, true);

  const bundle = generateDockerBundle(DEFAULT_CONFIG);
  assert.equal(bundle.length, 6);
  const readme = bundle.find((f) => f.filename === 'README.md')!.content;
  assert.ok(readme.includes('Erster Testlauf'));
  assert.ok(readme.includes('PUID'));
  assert.ok(readme.includes('Sicherheit & Empfehlungen'));
  assert.ok(readme.includes('MusicBrainz Picard'));
  assert.ok(readme.includes('beets'));
});
