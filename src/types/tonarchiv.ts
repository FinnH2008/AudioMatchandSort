export type AudioCodec =
  | 'flac'
  | 'alac'
  | 'pcm_s24le'
  | 'pcm_s16le'
  | 'aiff'
  | 'mp3'
  | 'aac'
  | 'vorbis'
  | 'opus'
  | 'wma';

export type MediaKind = 'audio' | 'video' | 'companion' | 'other';

export type QualityTier = 'lossless' | 'lossy_high' | 'lossy_low';

export type TrackClassification =
  | 'album_track'
  | 'dj_remix'
  | 'review_low_confidence'
  | 'review_no_release_match';

export type ManualAssignment = 'none' | 'album_track' | 'dj_remix' | 'duplicate';

export type CollisionType =
  | 'none'
  | 'path_collision'
  | 'smb_case_collision'
  | 'path_too_long';

export type TrackRunStatus =
  | 'pending'
  | 'analyzed'
  | 'tagged'
  | 'skipped_artist_conflict'
  | 'skipped_low_confidence'
  | 'moved'
  | 'conflict';

export type SourceProvider = 'musicbrainz' | 'shazamio' | 'discogs' | 'deezer';

export interface OriginalTagsSnapshot {
  artist: string;
  albumArtist: string;
  title: string;
  album: string;
  year: string;
  trackNumber: string;
  genre: string;
  key: string;
  bpm: number | null;
  compilation: boolean;
}

export interface SourceMatchCandidate {
  provider: SourceProvider;
  artist: string;
  albumArtist: string;
  title: string;
  album: string;
  year: string;
  confidence: number;
  mbRecordingId?: string;
  mbReleaseId?: string;
  mbArtistId?: string;
  notes: string;
}

export interface CoverInfo {
  status: 'fetched' | 'existing' | 'missing';
  source: 'Cover Art Archive' | 'Deezer High-Res' | 'Discogs' | 'ShazamIO' | 'Eingebettet' | 'Keine';
  resolution: string;
  sizeKb: number;
  embeddedBefore: boolean;
  imageUrl?: string;
  fallbackGradient: string;
}

export interface LyricsInfo {
  status: 'synced' | 'plain' | 'instrumental' | 'missing';
  source: 'LRCLIB' | 'Genius' | 'Musixmatch' | 'Keine';
  syncedLrc: string;
  plainText: string;
}

export interface AlbumReleaseCandidate {
  releaseId: string;
  title: string;
  albumArtist: string;
  year: string;
  country: string;
  format: string;
  trackCount: number;
  isCompilation: boolean;
  isRemixAlbum: boolean;
  matchScore: number;
  tracklist: Array<{
    position: number;
    title: string;
    durationSec: number;
  }>;
}

export interface AudioTrack {
  id: string;
  sourceRelativePath: string;
  sourceDir: string;
  fileName: string;
  extension: string;
  codec: AudioCodec;
  sizeBytes: number;
  mtimeIso: string;
  durationSec: number;
  bitrateKbps: number;
  sampleRateHz: number;
  bitDepth: number | null;
  spectralCutoffKhz: number | null;
  spectralWarningOnly: boolean;

  originalTags: OriginalTagsSnapshot;

  // Resolved metadata (may be modified by user / release matcher)
  albumArtist: string;
  artist: string;
  title: string;
  album: string;
  year: string;
  trackNumber: string;
  genre: string;
  isrc: string;
  compilationFlag: boolean;

  // Identification & Release
  mbRecordingId: string | null;
  mbArtistId: string | null;
  acoustidId: string | null;
  acoustidConfidence: number;
  activeSource: SourceProvider;
  sourceCandidates: SourceMatchCandidate[];
  cachedLookup: boolean;

  matchedRelease: AlbumReleaseCandidate | null;
  availableReleases: AlbumReleaseCandidate[];
  inMatchedReleaseTracklist: boolean;
  matchedReleaseTrackPos: number | null;
  isRemixAlbumTrack: boolean;
  detachedFromAlbum: boolean;
  detachReason: string | null;

  // Audio analysis (Essentia - optional)
  musicalKey: string;
  camelotKey: string;
  bpm: number | null;
  replayGainDb: number | null;

  // Enriched media
  cover: CoverInfo;
  lyrics: LyricsInfo;

  // Loose file indicator (no album / standalone folder)
  isLooseFile: boolean;

  // User manual overrides for review tracks
  manualAssignment: ManualAssignment;
  manualReleaseId: string | null;
  pendingReRunTagAndMove: boolean;

  // Runtime state
  status: TrackRunStatus;
  taggedAt: string | null;
  movedToPath: string | null;
  skippedInMode2Reason: string | null;
}

export interface CompanionFile {
  id: string;
  sourceRelativePath: string;
  sourceDir: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  albumKey: string;
  targetPath: string | null;
  moved: boolean;
}

export interface LeftoverFile {
  id: string;
  sourceRelativePath: string;
  sourceDir: string;
  fileName: string;
  kind: 'video' | 'other' | 'review_left_in_place';
  reason: string;
  sizeBytes: number;
}

export type ArtistClusterRule =
  | 'mbid_exact'
  | 'exact_normalization'
  | 'fuzzy_suggestion'
  | 'protected_band'
  | 'compilation_va';

export type ArtistClusterStatus = 'auto_resolved' | 'needs_review' | 'user_confirmed' | 'split_kept';

export interface ArtistCluster {
  id: string;
  canonicalName: string;
  mbArtistId: string | null;
  variants: string[];
  rule: ArtistClusterRule;
  similarityScore: number;
  status: ArtistClusterStatus;
  trackIds: string[];
  explanation: string;
}

export type DuplicateScope =
  | 'same_release'
  | 'both_unmatched'
  | 'loose_lossy_vs_lossless'
  | 'cross_album_notice';

export type DuplicateMatchReason =
  | 'mb_recording_id'
  | 'acoustid_fingerprint'
  | 'normalized_title_artist_duration';

export type DuplicateTiebreakerReason =
  | 'higher_quality'
  | 'more_complete_tags'
  | 'larger_file_size'
  | 'older_mtime';

export type DuplicateDecision = 'pending' | 'confirmed' | 'keep_both';

export interface DuplicateGroup {
  id: string;
  scope: DuplicateScope;
  matchReason: DuplicateMatchReason;
  tiebreakerReason: DuplicateTiebreakerReason;
  canonicalArtist: string;
  title: string;
  trackIds: string[];
  recommendedOriginalId: string;
  selectedOriginalId: string;
  decision: DuplicateDecision;
  crossAlbumNote?: string;
}

export type DjRemixLayout = 'root_folder' | 'split_by_quality';
export type MixedAlbumStrategy = 'lowest_quality' | 'manual_review';
export type KeyFormatMode = 'both' | 'camelot' | 'musical';

export interface PipelineConfig {
  hostMusicDir: string;
  containerMusicDir: string;
  configDir: string;
  puid: number;
  pgid: number;

  // Quality & Codec
  minLossyBitrateKbps: number;
  separateLowQualityLossy: boolean;
  mixedAlbumStrategy: MixedAlbumStrategy;

  // DJ-Remixes & Review
  djRemixLayout: DjRemixLayout;
  enrichRemixEmptyFields: boolean;
  keepReviewTracksInPlace: boolean;

  // Confidence & Sources
  confidenceThreshold: number;
  enableShazamFallback: boolean;
  enableEssentia: boolean;
  essentiaAvailable: boolean;
  acoustidKeyConfigured: boolean;
  discogsTokenConfigured: boolean;

  // Tagging, Cover, Lyrics & WAV
  keyFormat: KeyFormatMode;
  embedCover: boolean;
  coverMaxSize: 600 | 1000 | 1400;
  saveFolderCoverJpg: boolean;
  overwriteExistingCover: boolean;
  fetchLyrics: boolean;
  preferSyncedLrc: boolean;
  embedLyricsInFile: boolean;
  writeLrcSidecar: boolean;
  writeReplayGain: boolean;
  wavEmbedMedia: boolean;

  // Filesystem safety
  maxPathLength: number;
  smbCaseSafe: boolean;
  moveCompanionFiles: boolean;
  cleanupEmptyDirs: boolean;
  writeRollbackJournal: boolean;
}

export type JournalEntryStatus = 'pending' | 'done' | 'failed' | 'rolled_back';

export interface JournalEntry {
  id: string;
  kind: 'tag' | 'move_track' | 'move_companion';
  trackId?: string;
  fromPath: string;
  toPath: string;
  originalTags?: OriginalTagsSnapshot;
  status: JournalEntryStatus;
  timestampIso: string;
}

export interface RollbackJournal {
  runId: string | null;
  mode: 'idle' | 'tag' | 'move' | 'rerun';
  state: 'idle' | 'in_progress' | 'completed' | 'interrupted' | 'rolled_back';
  backupConfirmedAt: string | null;
  lastFsyncIso: string | null;
  entries: JournalEntry[];
  removedEmptyDirs: string[];
}

export type WorkflowModeId = 'analyze' | 'tag' | 'move';

export interface QueueErrorItem {
  id: string;
  stage: string;
  trackLabel: string;
  message: string;
  recovered: boolean;
}

export interface BackgroundQueueState {
  activeMode: WorkflowModeId | 'rerun' | null;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  processedCount: number;
  totalCount: number;
  errorCount: number;
  cacheHitCount: number;
  etaSeconds: number;
  currentTrackLabel: string;
  checkpointIndex: number;
  errors: QueueErrorItem[];
}

export interface SqliteCacheState {
  dbPath: string;
  fingerprintEntries: number;
  mbReleaseEntries: number;
  coverEntries: number;
  lyricsEntries: number;
  lastCheckpointIso: string | null;
  interruptedAnalyzeCheckpoint: number | null;
}

export interface EvaluatedTrackPlan {
  trackId: string;
  codecQuality: QualityTier;
  albumQuality: QualityTier;
  isMixedAlbum: boolean;
  classification: TrackClassification;
  resolvedAlbumArtist: string;
  hasOpenArtistConflict: boolean;
  willSkipInMode2: boolean;
  skipMode2Reason: string | null;
  willOverwriteCoreTags: boolean;
  willEnrichRemixEmptyFields: string[];
  wavMediaSkipped: boolean;
  isDuplicateToMove: boolean;
  duplicateGroupId: string | null;
  targetRelativePath: string;
  sanitizedChanged: boolean;
  collision: CollisionType;
  collisionDetail: string | null;
}

export interface AnalysisReport {
  totalAudioTracks: number;
  losslessCount: number;
  lossyHighCount: number;
  lossyLowCount: number;
  duplicateGroupCount: number;
  duplicateMoveCount: number;
  crossAlbumNoticeCount: number;
  fakeFlacWarningCount: number;
  djRemixCount: number;
  reviewLosslessCount: number;
  reviewLossyCount: number;
  mixedAlbumCount: number;
  detachedForeignTrackCount: number;
  openArtistConflictCount: number;
  skippedInMode2ArtistConflictCount: number;
  pathCollisionCount: number;
  companionFileCount: number;
  untouchedVideoAndLeftoverCount: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  hostMusicDir: '/srv/Music Full Quality',
  containerMusicDir: '/music',
  configDir: '/config',
  puid: 1000,
  pgid: 1000,

  minLossyBitrateKbps: 256,
  separateLowQualityLossy: true,
  mixedAlbumStrategy: 'lowest_quality',

  djRemixLayout: 'root_folder',
  enrichRemixEmptyFields: true,
  keepReviewTracksInPlace: false,

  confidenceThreshold: 0.8,
  enableShazamFallback: true,
  enableEssentia: true,
  essentiaAvailable: false,
  acoustidKeyConfigured: false,
  discogsTokenConfigured: false,

  keyFormat: 'both',
  embedCover: true,
  coverMaxSize: 1000,
  saveFolderCoverJpg: true,
  overwriteExistingCover: false,
  fetchLyrics: true,
  preferSyncedLrc: true,
  embedLyricsInFile: true,
  writeLrcSidecar: false,
  writeReplayGain: true,
  wavEmbedMedia: false,

  maxPathLength: 240,
  smbCaseSafe: true,
  moveCompanionFiles: true,
  cleanupEmptyDirs: true,
  writeRollbackJournal: true,
};
