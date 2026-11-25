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
import { generateDockerBundle } from './dockerGenerator';
import {
  isAudioCandidateExtension,
  isCompanionFileName,
  isVideoExtension,
  mapParsedCodec,
} from './localFolderScanner';
import { normalizeBackendState } from './apiClient';
import { AlbumReleaseCandidate, AudioTrack, DEFAULT_CONFIG } from '../types/tonarchiv';

// Minimal isolated factory strictly for unit tests (never imported by production code)
function makeTrack(overrides: Partial<AudioTrack> & { id: string }): AudioTrack {
  const title = overrides.title ?? 'Track';
  const artist = overrides.artist ?? 'Artist';
  const albumArtist = overrides.albumArtist ?? artist;
  const album = overrides.album ?? 'Album';
  const year = overrides.year ?? '2020';
  const trackNumber = overrides.trackNumber ?? '01';

  return {
    id: overrides.id,
    fileName: overrides.fileName ?? `${trackNumber} - ${title}.flac`,
    extension: overrides.extension ?? '.flac',
    sourceDir: overrides.sourceDir ?? 'src_album',
    sourceRelativePath: overrides.sourceRelativePath ?? `src_album/${trackNumber} - ${title}.flac`,
    sizeBytes: overrides.sizeBytes ?? 35_000_000,
    mtimeIso: overrides.mtimeIso ?? '2022-01-01T00:00:00Z',
    durationSec: overrides.durationSec ?? 240,
    codec: overrides.codec ?? 'flac',
    sampleRateHz: overrides.sampleRateHz ?? 44100,
    bitDepth: overrides.bitDepth === undefined ? 16 : overrides.bitDepth,
    bitrateKbps: overrides.bitrateKbps ?? 980,
    spectralCutoffKhz: overrides.spectralCutoffKhz ?? null,
    spectralWarningOnly: overrides.spectralWarningOnly ?? false,
    artist,
    albumArtist,
    title,
    album,
    year,
    trackNumber,
    genre: overrides.genre ?? 'Electronic',
    isrc: overrides.isrc ?? '',
    compilationFlag: overrides.compilationFlag ?? false,
    isLooseFile: overrides.isLooseFile ?? false,
    originalTags: overrides.originalTags ?? {
      artist,
      albumArtist,
      title,
      album,
      year,
      trackNumber,
      genre: overrides.genre ?? 'Electronic',
      key: '8A',
      bpm: 120,
      compilation: overrides.compilationFlag ?? false,
    },
    mbArtistId: overrides.mbArtistId ?? null,
    mbRecordingId: overrides.mbRecordingId ?? null,
    acoustidId: overrides.acoustidId ?? null,
    acoustidConfidence: overrides.acoustidConfidence ?? 0.96,
    matchedRelease: overrides.matchedRelease ?? null,
    availableReleases: overrides.availableReleases ?? [],
    inMatchedReleaseTracklist: overrides.inMatchedReleaseTracklist ?? false,
    matchedReleaseTrackPos: overrides.matchedReleaseTrackPos ?? null,
    isRemixAlbumTrack: overrides.isRemixAlbumTrack ?? false,
    detachedFromAlbum: overrides.detachedFromAlbum ?? false,
    detachReason: overrides.detachReason ?? null,
    activeSource: overrides.activeSource ?? 'musicbrainz',
    sourceCandidates: overrides.sourceCandidates ?? [],
    cachedLookup: overrides.cachedLookup ?? false,
    camelotKey: overrides.camelotKey ?? '8A',
    musicalKey: overrides.musicalKey ?? 'A min',
    bpm: overrides.bpm === undefined ? 120 : overrides.bpm,
    replayGainDb: overrides.replayGainDb ?? -5.2,
    cover: overrides.cover ?? {
      status: 'existing',
      source: 'Eingebettet',
      resolution: '1000×1000',
      sizeKb: 220,
      imageUrl: undefined,
      fallbackGradient: 'from-slate-800 to-slate-900',
      embeddedBefore: true,
    },
    lyrics: overrides.lyrics ?? {
      status: 'synced',
      source: 'LRCLIB',
      syncedLrc: '[00:01.00] Line',
      plainText: 'Line',
    },
    manualAssignment: overrides.manualAssignment ?? 'none',
    manualReleaseId: overrides.manualReleaseId ?? null,
    pendingReRunTagAndMove: overrides.pendingReRunTagAndMove ?? false,
    status: overrides.status ?? 'pending',
    skippedInMode2Reason: overrides.skippedInMode2Reason ?? null,
    taggedAt: overrides.taggedAt ?? null,
    movedToPath: overrides.movedToPath ?? null,
  };
}

const REL_DISCOVERY: AlbumReleaseCandidate = {
  releaseId: 'rel-discovery',
  title: 'Discovery',
  albumArtist: 'Daft Punk',
  year: '2001',
  country: 'EU',
  format: 'CD',
  trackCount: 14,
  isCompilation: false,
  isRemixAlbum: false,
  matchScore: 0.97,
  tracklist: [
    { position: 1, title: 'One More Time', durationSec: 320 },
    { position: 15, title: 'Aerodynamic (Daft Punk Remix)', durationSec: 370 },
  ],
};

const REL_BRAVO: AlbumReleaseCandidate = {
  releaseId: 'rel-bravo-124',
  title: 'Bravo Hits 124',
  albumArtist: 'Various Artists',
  year: '2024',
  country: 'DE',
  format: '2×CD · Compilation',
  trackCount: 44,
  isCompilation: true,
  isRemixAlbum: false,
  matchScore: 0.94,
  tracklist: [{ position: 1, title: 'One More Time', durationSec: 320 }],
};

test('Codec classification distinguishes M4A ALAC (lossless) vs M4A AAC (lossy)', () => {
  assert.equal(classifyCodecQuality('alac', 1060, 256, true), 'lossless');
  assert.equal(classifyCodecQuality('aac', 256, 256, true), 'lossy_high');
  assert.equal(classifyCodecQuality('aac', 128, 256, true), 'lossy_low');
  assert.equal(classifyCodecQuality('pcm_s16le', 1411, 256, true), 'lossless');
  assert.equal(isWavCodec('pcm_s16le', '.wav'), true);
});

test('Local folder scanner maps real parsed codecs, companions, and video files accurately', () => {
  assert.equal(mapParsedCodec('ALAC', 'M4A', '.m4a', 16), 'alac');
  assert.equal(mapParsedCodec('AAC', 'MPEG-4', '.m4a', undefined), 'aac');
  assert.equal(mapParsedCodec('PCM', 'WAVE', '.wav', 24), 'pcm_s24le');
  assert.equal(isCompanionFileName('cover.jpg'), true);
  assert.equal(isCompanionFileName('ExactAudioCopy.log'), true);
  assert.equal(isVideoExtension('.mkv'), true);
  assert.equal(isAudioCandidateExtension('.flac'), true);
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
  const tracks = [
    makeTrack({ id: 't1', artist: 'Tiësto', albumArtist: 'Tiësto', mbArtistId: 'mb-tiesto' }),
    makeTrack({ id: 't2', artist: 'DJ Tiesto', albumArtist: 'DJ Tiesto', mbArtistId: null }),
    makeTrack({ id: 't3', artist: 'Röyksopp', albumArtist: 'Röyksopp', mbArtistId: 'mb-royk' }),
    makeTrack({ id: 't4', artist: 'Royksopp', albumArtist: 'Royksopp', mbArtistId: null }),
  ];
  const { clusters } = buildArtistClusters(tracks);

  const fuzzy = clusters.filter((c) => c.rule === 'fuzzy_suggestion');
  assert.equal(fuzzy.length, 1);
  assert.equal(fuzzy[0].status, 'needs_review');

  const royksopp = clusters.find((c) => c.canonicalName === 'Röyksopp');
  assert.ok(royksopp);
  assert.equal(royksopp.status, 'auto_resolved');
});

test('Album-aware duplicates separate true duplicates (_Duplikate) from cross-album notices (Auch auf Album X)', () => {
  const tracks = [
    makeTrack({
      id: 't-hi',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: 'Discovery',
      codec: 'flac',
      bitDepth: 24,
      sampleRateHz: 96000,
      bitrateKbps: 2810,
      mbRecordingId: 'rec-omt',
      matchedRelease: REL_DISCOVERY,
      inMatchedReleaseTracklist: true,
    }),
    makeTrack({
      id: 't-lo-same',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: 'Discovery',
      codec: 'flac',
      bitDepth: 16,
      sampleRateHz: 44100,
      bitrateKbps: 960,
      mbRecordingId: 'rec-omt',
      matchedRelease: REL_DISCOVERY,
      inMatchedReleaseTracklist: true,
    }),
    makeTrack({
      id: 't-loose',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: '',
      isLooseFile: true,
      codec: 'mp3',
      extension: '.mp3',
      bitDepth: null,
      bitrateKbps: 128,
      mbRecordingId: 'rec-omt',
      matchedRelease: null,
    }),
    makeTrack({
      id: 't-bravo',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Various Artists',
      album: 'Bravo Hits 124',
      year: '2024',
      compilationFlag: true,
      codec: 'mp3',
      extension: '.mp3',
      bitDepth: null,
      bitrateKbps: 320,
      mbRecordingId: 'rec-omt',
      matchedRelease: REL_BRAVO,
      inMatchedReleaseTracklist: true,
    }),
  ];

  const res = evaluateLibraryPlan(
    tracks,
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  assert.equal(res.trackPlans.get('t-bravo')?.isDuplicateToMove, false);
  assert.ok(
    res.trackPlans.get('t-bravo')?.targetRelativePath.startsWith('Lossy/Various Artists/2024 - Bravo Hits 124/')
  );

  const crossNotices = res.duplicateGroups.filter((g) => g.scope === 'cross_album_notice');
  assert.equal(crossNotices.length, 1);
  assert.ok(crossNotices[0].crossAlbumNote?.includes('Auch auf Album'));

  assert.equal(res.trackPlans.get('t-lo-same')?.isDuplicateToMove, true);
  assert.equal(res.trackPlans.get('t-loose')?.isDuplicateToMove, true);
});

test('Duplicate tiebreaker order: higher quality -> more complete tags -> larger size -> older mtime', () => {
  const rich = makeTrack({ id: 'rich', codec: 'alac', bitDepth: 16, sampleRateHz: 44100, bitrateKbps: 1060 });
  const sparse = makeTrack({
    id: 'sparse',
    codec: 'alac',
    bitDepth: 16,
    sampleRateHz: 44100,
    bitrateKbps: 1060,
    originalTags: {
      artist: 'Artist',
      albumArtist: '',
      title: 'Track',
      album: '',
      year: '',
      trackNumber: '',
      genre: '',
      key: '',
      bpm: null,
      compilation: false,
    },
  });
  const cmp = compareDuplicateCandidates(rich, sparse);
  assert.equal(cmp.winner.id, 'rich');
  assert.equal(cmp.reason, 'more_complete_tags');
});

test('Official album remixes stay in album while non-tracklist bootlegs detach to DJ-Remixes (Option A & B)', () => {
  const officialRemix = makeTrack({
    id: 'off',
    title: 'Aerodynamic (Daft Punk Remix)',
    artist: 'Daft Punk',
    albumArtist: 'Daft Punk',
    album: 'Discovery',
    sourceDir: 'disc',
    mbRecordingId: 'rec-aero-remix',
    acoustidConfidence: 0.96,
    matchedRelease: REL_DISCOVERY,
    inMatchedReleaseTracklist: true,
    matchedReleaseTrackPos: 15,
  });
  const bootleg = makeTrack({
    id: 'boot',
    title: 'One More Time (Club Bootleg Edit)',
    artist: 'Daft Punk',
    albumArtist: 'Daft Punk',
    album: 'Discovery',
    sourceDir: 'disc',
    codec: 'mp3',
    extension: '.mp3',
    bitDepth: null,
    bitrateKbps: 320,
    acoustidConfidence: 0.55,
    matchedRelease: REL_DISCOVERY,
    inMatchedReleaseTracklist: false,
  });

  const resA = evaluateLibraryPlan(
    [officialRemix, bootleg],
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.equal(resA.trackPlans.get('off')?.classification, 'album_track');
  assert.equal(resA.trackPlans.get('boot')?.classification, 'dj_remix');
  assert.ok(resA.trackPlans.get('boot')?.targetRelativePath.startsWith('DJ-Remixes/'));

  const resB = evaluateLibraryPlan(
    [officialRemix, bootleg],
    [],
    [],
    { ...DEFAULT_CONFIG, djRemixLayout: 'split_by_quality' },
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.ok(resB.trackPlans.get('boot')?.targetRelativePath.startsWith('Lossy/DJ-Remixes/'));
});

test('Quality-split _Review/Lossless and _Review/Lossy routing plus keepReviewTracksInPlace option', () => {
  const revFlac = makeTrack({
    id: 'r1',
    title: 'Session Jam',
    codec: 'flac',
    extension: '.flac',
    sourceRelativePath: 'rips/Session/01.flac',
    matchedRelease: null,
    acoustidConfidence: 0.9,
  });
  const revOgg = makeTrack({
    id: 'r2',
    title: 'Warmup Cut',
    codec: 'vorbis',
    extension: '.ogg',
    bitDepth: null,
    bitrateKbps: 256,
    sourceRelativePath: 'unsorted/02.ogg',
    matchedRelease: null,
    acoustidConfidence: 0.62,
  });

  const res = evaluateLibraryPlan(
    [revFlac, revOgg],
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.equal(res.trackPlans.get('r1')?.targetRelativePath, '_Review/Lossless/rips/Session/01.flac');
  assert.equal(res.trackPlans.get('r2')?.targetRelativePath, '_Review/Lossy/unsorted/02.ogg');

  const resKeep = evaluateLibraryPlan(
    [revFlac, revOgg],
    [],
    [],
    { ...DEFAULT_CONFIG, keepReviewTracksInPlace: true },
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.equal(resKeep.trackPlans.get('r1')?.targetRelativePath, 'rips/Session/01.flac');
});

test('Fake-FLAC spectral warning never demotes Lossless track, and WAV media embedding defaults OFF', () => {
  const fakeFlac = makeTrack({
    id: 'ff',
    title: 'Fake Flac Track',
    codec: 'flac',
    spectralWarningOnly: true,
    spectralCutoffKhz: 16.1,
    matchedRelease: REL_DISCOVERY,
    inMatchedReleaseTracklist: true,
  });
  const wav = makeTrack({
    id: 'wav',
    title: 'Wav Master Track',
    codec: 'pcm_s16le',
    extension: '.wav',
    matchedRelease: REL_DISCOVERY,
    inMatchedReleaseTracklist: true,
  });

  const res = evaluateLibraryPlan(
    [fakeFlac, wav],
    [],
    [],
    { ...DEFAULT_CONFIG, essentiaAvailable: true },
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.ok(res.trackPlans.get('ff')?.targetRelativePath.startsWith('Lossless/'));
  assert.equal(res.report.fakeFlacWarningCount, 1);
  assert.equal(res.trackPlans.get('wav')?.wavMediaSkipped, true);
});

test('3-Mode Gate handles empty library, browser-only read-only mode, conflicts, and Re-Run', () => {
  const empty = computeNextModeAction({
    mode1Completed: false,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 0,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 0,
    backendConnected: false,
  });
  assert.equal(empty.enabled, false);
  assert.equal(empty.label, 'Keine Dateien geladen');

  const emptyConnected = computeNextModeAction({
    mode1Completed: false,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 0,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 0,
    backendConnected: true,
  });
  assert.equal(emptyConnected.enabled, true);
  assert.equal(emptyConnected.mode, 'analyze');

  const m2BrowserOnly = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 0,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 5,
    backendConnected: false,
  });
  assert.equal(m2BrowserOnly.enabled, false);

  const m2Backend = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: false,
    mode3Completed: false,
    openArtistConflictCount: 2,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 5,
    backendConnected: true,
  });
  assert.equal(m2Backend.enabled, true);

  const m3Blocked = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: true,
    mode3Completed: false,
    openArtistConflictCount: 2,
    pathCollisionCount: 0,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 5,
    backendConnected: true,
  });
  assert.equal(m3Blocked.enabled, false);

  const rerun = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: true,
    mode3Completed: true,
    openArtistConflictCount: 0,
    pathCollisionCount: 0,
    pendingReRunCount: 1,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: 5,
    backendConnected: true,
  });
  assert.equal(rerun.mode, 'rerun');
  assert.equal(rerun.enabled, true);
});

test('Compilation release matcher searches exclusively compilation releases and Docker bundle contains required sections', () => {
  const bravoTrack = makeTrack({
    id: 'b1',
    album: 'Bravo Hits 124',
    albumArtist: 'Various Artists',
    compilationFlag: true,
    matchedRelease: REL_BRAVO,
  });
  assert.equal(isCompilationAlbumGroup('Bravo Hits 124', [bravoTrack]), true);
  const picked = selectBestAlbumRelease('Bravo Hits 124', [bravoTrack], [REL_DISCOVERY, REL_BRAVO]);
  assert.equal(picked?.isCompilation, true);

  const bundle = generateDockerBundle(DEFAULT_CONFIG, 'ghcr.io/meinuser/tonarchiv:latest');
  assert.equal(bundle.length, 10);
  const compose = bundle.find((f) => f.filename === 'docker-compose.yml')!.content;
  assert.ok(compose.includes('${TONARCHIV_IMAGE:-ghcr.io/meinuser/tonarchiv:latest}'));
  assert.ok(compose.includes('pull_policy: always'));
  assert.ok(compose.includes('AUTO_ANALYZE_ON_START'));
  assert.ok(compose.includes('tonarchiv_config:/config'));
  assert.ok(compose.includes('${TONARCHIV_PORT:-7070}:7070'));
  assert.equal(compose.includes('env_file:'), false);
  assert.equal(compose.includes('build:'), false);
  const workflow = bundle.find((f) => f.filename === '.github/workflows/docker-publish.yml')!.content;
  assert.ok(workflow.includes('ghcr.io'));
  assert.ok(workflow.includes('linux/amd64,linux/arm64'));
  const dockerfile = bundle.find((f) => f.filename === 'Dockerfile')!.content;
  assert.ok(dockerfile.includes('COPY package.json package-lock.json* .npmrc* ./'));
  assert.ok(dockerfile.includes('--legacy-peer-deps'));
  assert.ok(dockerfile.includes('EXPOSE 7070'));
  assert.ok(dockerfile.includes('ENTRYPOINT ["/app/entrypoint.sh"]'));
  const entrypoint = bundle.find((f) => f.filename === 'backend/entrypoint.sh')!.content;
  assert.ok(entrypoint.includes('--port 7070'));
  const npmrc = bundle.find((f) => f.filename === '.npmrc')!.content;
  assert.ok(npmrc.includes('legacy-peer-deps=true'));
  const envEx = bundle.find((f) => f.filename === '.env.example')!.content;
  assert.ok(envEx.includes('TONARCHIV_IMAGE=ghcr.io/meinuser/tonarchiv:latest'));
  assert.ok(envEx.includes('TONARCHIV_PORT=7070'));
  assert.ok(envEx.includes('AUTO_ANALYZE_ON_START=false'));
  assert.ok(envEx.includes('ACOUSTID_API_KEY='));
  assert.ok(envEx.includes('DISCOGS_TOKEN='));
  const readme = bundle.find((f) => f.filename === 'README.md')!.content;
  assert.ok(readme.includes('Erster Testlauf'));
  assert.ok(readme.includes(':7070'));
  assert.ok(readme.includes('PUID'));
  assert.ok(readme.includes('Sicherheit & Empfehlungen'));
  assert.ok(readme.includes('MusicBrainz Picard'));
  assert.ok(readme.includes('beets'));
});

test('Legacy backend state payload with string tracklist entries and missing matchScore evaluates safely without throwing', () => {
  const legacyRelease = {
    releaseId: 'rel-legacy-1',
    title: 'Discovery',
    albumArtist: 'Daft Punk',
    year: '2001',
    country: 'XW',
    format: 'Digital Media',
    trackCount: 14,
    isCompilation: false,
    isRemixAlbum: false,
    // Deliberately malformed legacy backend format (string[] instead of object[], missing matchScore)
    tracklist: ['One More Time'],
  } as unknown as AlbumReleaseCandidate;

  const track = makeTrack({
    id: 'legacy-1',
    title: 'One More Time',
    artist: 'Daft Punk',
    albumArtist: 'Daft Punk',
    album: 'Discovery',
    matchedRelease: legacyRelease,
    availableReleases: [legacyRelease],
    inMatchedReleaseTracklist: true,
    acoustidConfidence: 0.95,
    mbRecordingId: 'rec-1',
  });

  const res = evaluateLibraryPlan(
    [track],
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  assert.equal(res.trackPlans.get('legacy-1')?.classification, 'album_track');
  assert.ok(res.trackPlans.get('legacy-1')?.targetRelativePath.startsWith('Lossless/Daft Punk/'));
});

test('normalizeBackendState + evaluateLibraryPlan survives hostile malformed fields and processes 3,000 tracks / 1,200 artists fast (<500ms)', () => {
  // 1) Hostile malformed payload with nulls, missing nested objects, non-array lists, string tracklists
  const hostileRaw = {
    mode1Completed: true,
    tracks: [
      {
        id: 'hostile-1',
        fileName: null,
        extension: null,
        sourceDir: null,
        sourceRelativePath: null,
        sizeBytes: 'not-a-number',
        mtimeIso: null,
        codec: null,
        sampleRateHz: null,
        bitrateKbps: null,
        artist: null,
        albumArtist: undefined,
        title: null,
        album: null,
        year: 2023,
        trackNumber: 3,
        originalTags: null,
        cover: null,
        lyrics: null,
        acoustidConfidence: null,
        matchedRelease: {
          releaseId: 'rel-h1',
          title: 'Broken Release',
          albumArtist: null,
          year: 2023,
          tracklist: ['Legacy String Entry', null, { title: 'Obj Entry' }],
        },
        availableReleases: [null, { title: 'Partial', tracklist: 'bad' }],
        lookupError: 'MusicBrainz nicht erreichbar (übersprungen).',
      },
      null,
      'not-an-object',
    ],
    companions: 'not-an-array',
    leftovers: null,
    queue: { status: 'running', processedCount: 392, totalCount: 2622, errors: [null, 'err-1'] },
    journal: { entries: null, removedEmptyDirs: 'bad' },
  };

  const sanitizedHostile = normalizeBackendState(hostileRaw);
  assert.ok(sanitizedHostile);
  assert.equal(sanitizedHostile.tracks.length, 1);
  assert.equal(sanitizedHostile.tracks[0].id, 'hostile-1');
  assert.equal(sanitizedHostile.tracks[0].lookupError, 'MusicBrainz nicht erreichbar (übersprungen).');
  assert.equal(sanitizedHostile.tracks[0].originalTags.title, '');
  assert.equal(sanitizedHostile.tracks[0].cover.status, 'missing');
  assert.equal(sanitizedHostile.tracks[0].lyrics.status, 'missing');
  assert.ok(sanitizedHostile.queue);
  assert.equal(sanitizedHostile.queue.errors.length, 1);
  assert.equal(sanitizedHostile.queue.errors[0].message, 'err-1');

  const hostilePlan = evaluateLibraryPlan(
    sanitizedHostile.tracks,
    sanitizedHostile.companions,
    sanitizedHostile.leftovers,
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  assert.equal(hostilePlan.trackPlans.size, 1);

  // 2) 3,000-track / 1,200-unique-artist stress benchmark (must never hang mobile main thread)
  const rawBigTracks = [];
  for (let i = 0; i < 3000; i += 1) {
    const artistIdx = i % 1200;
    const baseArtist =
      artistIdx % 40 === 0
        ? `DJ Artist ${artistIdx}`
        : artistIdx % 40 === 1
          ? `Artist ${artistIdx - 1}`
          : `Künstler ${artistIdx} Band`;
    const albumIdx = i % 400;
    rawBigTracks.push({
      id: `trk-${i}`,
      fileName: `0${(i % 9) + 1} - Song ${i}.flac`,
      extension: i % 3 === 0 ? '.mp3' : '.flac',
      sourceDir: `album_${albumIdx}`,
      sourceRelativePath: `album_${albumIdx}/0${(i % 9) + 1} - Song ${i}.${i % 3 === 0 ? 'mp3' : 'flac'}`,
      sizeBytes: 25_000_000,
      mtimeIso: '2024-01-01T00:00:00Z',
      durationSec: 215,
      codec: i % 3 === 0 ? 'mp3' : 'flac',
      sampleRateHz: 44100,
      bitDepth: i % 3 === 0 ? null : 16,
      bitrateKbps: i % 3 === 0 ? 320 : 950,
      artist: baseArtist,
      albumArtist: baseArtist,
      title: `Song ${i}`,
      album: `Album ${albumIdx}`,
      year: '2022',
      trackNumber: String((i % 12) + 1).padStart(2, '0'),
      acoustidConfidence: i % 5 === 0 ? 0.65 : 0.96,
      mbRecordingId: i % 4 === 0 ? `rec-${i % 1500}` : null,
      matchedRelease:
        i % 5 === 0
          ? null
          : {
              releaseId: `rel-${albumIdx}`,
              title: `Album ${albumIdx}`,
              albumArtist: baseArtist,
              year: '2022',
              country: 'DE',
              format: 'CD',
              trackCount: 12,
              isCompilation: false,
              isRemixAlbum: false,
              matchScore: 0.94,
              tracklist: [{ position: 1, title: `Song ${i}`, durationSec: 215 }],
            },
      inMatchedReleaseTracklist: i % 5 !== 0,
    });
  }

  const t0 = performance.now();
  const normalizedBig = normalizeBackendState({ tracks: rawBigTracks });
  assert.ok(normalizedBig);
  const bigPlan = evaluateLibraryPlan(
    normalizedBig.tracks,
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );
  const elapsedMs = performance.now() - t0;

  assert.equal(bigPlan.trackPlans.size, 3000);
  assert.ok(
    elapsedMs < 500,
    `Expected 3,000 tracks / 1,200 artists to evaluate in <500ms, took ${elapsedMs.toFixed(1)}ms`
  );
});

test('evaluateLibraryPlan auto-disambiguates colliding and overly long paths without overwriting so Mode 3 unlocks cleanly', () => {
  const deepDir = 'unsorted/very_long_folder_name_01/very_long_folder_name_02/very_long_folder_name_03/very_long_folder_name_04/very_long_folder_name_05/very_long_folder_name_06';
  const tracks = [
    // Two identical 320k MP3 copies in _Duplikate/ (plus higher quality original)
    makeTrack({
      id: 'dup-orig',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: 'Discovery',
      codec: 'flac',
      bitDepth: 24,
      bitrateKbps: 2800,
      mbRecordingId: 'rec-dup',
      matchedRelease: REL_DISCOVERY,
      inMatchedReleaseTracklist: true,
    }),
    makeTrack({
      id: 'dup-mp3-1',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: '',
      isLooseFile: true,
      codec: 'mp3',
      extension: '.mp3',
      bitDepth: null,
      bitrateKbps: 320,
      sourceRelativePath: 'loose/a/omt.mp3',
      mbRecordingId: 'rec-dup',
    }),
    makeTrack({
      id: 'dup-mp3-2',
      title: 'One More Time',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: '',
      isLooseFile: true,
      codec: 'mp3',
      extension: '.mp3',
      bitDepth: null,
      bitrateKbps: 320,
      sourceRelativePath: 'loose/b/omt.mp3',
      mbRecordingId: 'rec-dup',
    }),
    // Extremely deep _Review path (> 220 chars)
    makeTrack({
      id: 'too-long-review',
      title: 'Very Long Unmatched Live Recording Title That Would Exceed Max Path Length',
      artist: 'Unknown DJ',
      albumArtist: 'Unknown DJ',
      album: '',
      codec: 'mp3',
      extension: '.mp3',
      bitDepth: null,
      bitrateKbps: 192,
      sourceDir: deepDir,
      sourceRelativePath: `${deepDir}/very_long_unmatched_live_recording_filename_exceeding_limits.mp3`,
      acoustidConfidence: 0.4,
      matchedRelease: null,
    }),
  ];

  const plan = evaluateLibraryPlan(
    tracks,
    [],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  // Every track must have a unique target path and 0 unresolved collisions
  assert.equal(plan.report.pathCollisionCount, 0);
  const targetPaths = tracks.map((t) => plan.trackPlans.get(t.id)!.targetRelativePath);
  assert.equal(new Set(targetPaths.map((p) => p.toLowerCase())).size, tracks.length);
  assert.ok(targetPaths.every((p) => p.length <= DEFAULT_CONFIG.maxPathLength));

  const dup1 = plan.trackPlans.get('dup-mp3-1')!.targetRelativePath;
  const dup2 = plan.trackPlans.get('dup-mp3-2')!.targetRelativePath;
  assert.notEqual(dup1.toLowerCase(), dup2.toLowerCase());
  assert.ok(dup2.includes('(2)'), `Expected disambiguated suffix (2) in ${dup2}`);

  const nextAction = computeNextModeAction({
    mode1Completed: true,
    mode2Completed: true,
    mode3Completed: false,
    openArtistConflictCount: plan.report.openArtistConflictCount,
    pathCollisionCount: plan.report.pathCollisionCount,
    pendingReRunCount: 0,
    queueRunningOrPaused: false,
    hasInterruptedJournal: false,
    totalTracks: tracks.length,
    backendConnected: true,
  });
  assert.equal(nextAction.mode, 'move');
  assert.equal(nextAction.enabled, true);
});

test('Companion files follow _Review / DJ-Remixes target directories and _Review never double-nests on rescan', () => {
  const revTrack = makeTrack({
    id: 'rev-comp-1',
    title: 'Already Reviewed',
    codec: 'flac',
    extension: '.flac',
    sourceDir: '_Review/Lossless/old_artist/old_album',
    sourceRelativePath: '_Review/Lossless/old_artist/old_album/01.flac',
    acoustidConfidence: 0.4,
    matchedRelease: null,
  });
  const unmovedRev = makeTrack({
    id: 'rev-comp-2',
    title: 'Fresh Review',
    codec: 'mp3',
    extension: '.mp3',
    bitDepth: null,
    bitrateKbps: 192,
    sourceDir: 'legacy_artist/legacy_album',
    sourceRelativePath: 'legacy_artist/legacy_album/02.mp3',
    acoustidConfidence: 0.3,
    matchedRelease: null,
  });

  const plan = evaluateLibraryPlan(
    [revTrack, unmovedRev],
    [
      {
        id: 'comp-rev',
        sourceRelativePath: 'legacy_artist/legacy_album/cover.jpg',
        sourceDir: 'legacy_artist/legacy_album',
        fileName: 'cover.jpg',
        extension: '.jpg',
        sizeBytes: 50000,
        albumKey: 'legacy_artist/legacy_album',
        targetPath: null,
        moved: false,
      },
    ],
    [],
    DEFAULT_CONFIG,
    { decisions: {}, renamedCanonical: {} },
    { decisions: {}, selectedOriginals: {} }
  );

  assert.equal(
    plan.trackPlans.get('rev-comp-1')?.targetRelativePath,
    '_Review/Lossless/old_artist/old_album/01.flac'
  );
  assert.equal(
    plan.evaluatedCompanions[0].targetPath,
    '_Review/Lossy/legacy_artist/legacy_album/cover.jpg'
  );
});



