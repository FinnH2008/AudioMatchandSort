import {
  AlbumReleaseCandidate,
  AnalysisReport,
  ArtistCluster,
  AudioTrack,
  CompanionFile,
  DuplicateDecision,
  DuplicateGroup,
  DuplicateMatchReason,
  DuplicateScope,
  DuplicateTiebreakerReason,
  EvaluatedTrackPlan,
  LeftoverFile,
  PipelineConfig,
  QualityTier,
  TrackClassification,
} from '../types/tonarchiv';
import {
  ArtistResolutionOverrides,
  buildArtistClusters,
  normalizeArtistExact,
} from './artistDedupe';
import {
  classifyCodecQuality,
  computeAudioQualityScore,
  detectPathCollisions,
  ensureUniqueRelativePaths,
  isLosslessCodec,
  isWavCodec,
  sanitizeRelativePath,
} from './codecAndSanitizer';

const REMIX_TITLE_KEYWORD_REGEX = /\b(remix|edit|bootleg|mashup)\b/i;
const REMIX_ALBUM_KEYWORD_REGEX = /\b(remix|remixed|remixes|club edition|club mixes)\b/i;
const COMPILATION_ALBUM_KEYWORD_REGEX = /\b(hits|sampler|various|best of|compilation|charts)\b/i;

export function hasRemixKeyword(text: string | null | undefined): boolean {
  return REMIX_TITLE_KEYWORD_REGEX.test(String(text ?? ''));
}

export function normalizeTitleForMatch(title: string | null | undefined): string {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Checks whether an album group should search exclusively among Compilation releases
 * (per Rule 3: album contains "Hits", "Sampler", "Various" OR >= 4 distinct track artists).
 */
export function isCompilationAlbumGroup(albumName: string, tracks: AudioTrack[]): boolean {
  if (COMPILATION_ALBUM_KEYWORD_REGEX.test(String(albumName ?? ''))) {
    return true;
  }
  const distinctArtists = new Set(
    tracks.map((t) => normalizeArtistExact(t.artist || t.originalTags?.artist || '')).filter(Boolean)
  );
  if (distinctArtists.size >= 4) {
    return true;
  }
  return tracks.some(
    (t) =>
      t.compilationFlag ||
      normalizeArtistExact(t.albumArtist || t.originalTags?.albumArtist || '') === 'various artists'
  );
}

/**
 * Selects the best MusicBrainz release for an album group:
 * - Compilations search exclusively among compilation releases.
 * - Non-compilations penalize singles/samplers and prefer matching track count & studio format.
 */
export function selectBestAlbumRelease(
  albumName: string,
  albumTracks: AudioTrack[],
  candidates: AlbumReleaseCandidate[]
): AlbumReleaseCandidate | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const expectCompilation = isCompilationAlbumGroup(albumName, albumTracks);

  const filtered = expectCompilation
    ? candidates.filter((c) => c.isCompilation)
    : candidates.filter((c) => !c.isCompilation);

  const pool = filtered.length > 0 ? filtered : expectCompilation ? [] : candidates;
  if (pool.length === 0) return null;

  const scored = pool.map((release) => {
    let score = typeof release.matchScore === 'number' ? release.matchScore : 0.85;
    if (!expectCompilation) {
      if (String(release.format ?? '').toLowerCase().includes('single')) score -= 0.35;
      if (release.isCompilation) score -= 0.4;
    }
    const trackDiff = Math.abs((release.trackCount || 1) - albumTracks.length);
    const maxPenalty = expectCompilation ? 0.12 : 0.22;
    score -= Math.min(maxPenalty, trackDiff * 0.02);
    return { release, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  return winner && winner.score >= 0.72 ? winner.release : null;
}

/**
 * Checks whether a track exists in the matched release's tracklist
 * (normalized title + optional position + duration ±3 s).
 * Tolerates both structured tracklist objects and legacy plain-string entries from older state.json files.
 */
export function isTrackInReleaseTracklist(
  track: AudioTrack,
  release: AlbumReleaseCandidate | null
): { matched: boolean; position: number | null } {
  if (!release || !Array.isArray(release.tracklist)) return { matched: false, position: null };
  const normTrackTitle = normalizeTitleForMatch(track.title || track.originalTags?.title || '');
  const trackPos = Number.parseInt(String(track.trackNumber ?? ''), 10);

  for (let idx = 0; idx < release.tracklist.length; idx++) {
    const rawItem = release.tracklist[idx] as
      | { position?: number; title?: string; durationSec?: number }
      | string
      | null
      | undefined;
    if (!rawItem) continue;

    const itemTitle = typeof rawItem === 'string' ? rawItem : String(rawItem.title ?? '');
    const itemPos =
      typeof rawItem === 'string'
        ? idx + 1
        : typeof rawItem.position === 'number'
          ? rawItem.position
          : idx + 1;
    const itemDuration =
      typeof rawItem === 'string' || typeof rawItem.durationSec !== 'number'
        ? null
        : rawItem.durationSec;

    const normItemTitle = normalizeTitleForMatch(itemTitle);
    if (!normItemTitle || !normTrackTitle) continue;

    const durationOk =
      itemDuration === null || itemDuration <= 0 || Math.abs(itemDuration - (track.durationSec || 0)) <= 3;
    const titleOk =
      normItemTitle === normTrackTitle ||
      normItemTitle.includes(normTrackTitle) ||
      normTrackTitle.includes(normItemTitle);
    const posOk =
      typeof rawItem === 'string' || Number.isNaN(trackPos) || trackPos === itemPos;
    if (titleOk && durationOk && posOk) {
      return { matched: true, position: itemPos };
    }
  }
  return { matched: false, position: null };
}

/**
 * Checks whether an album group qualifies as a complete Remix Album that stays intact
 * (album title has Remix/Remixed/Remixes/Club Edition OR >50% tracks have remix keyword AND matched release).
 */
export function isWholeRemixAlbum(
  albumName: string,
  albumTracks: AudioTrack[],
  matchedRelease: AlbumReleaseCandidate | null
): boolean {
  if (!matchedRelease) return false;
  if (matchedRelease.isRemixAlbum || REMIX_ALBUM_KEYWORD_REGEX.test(String(albumName ?? ''))) {
    return true;
  }
  if (albumTracks.length === 0) return false;
  const remixCount = albumTracks.filter((t) =>
    hasRemixKeyword(t.title || t.originalTags?.title || '')
  ).length;
  return remixCount / albumTracks.length > 0.5;
}

/**
 * Computes tag completeness count for deterministic duplicate tiebreaking.
 */
export function countCompleteTags(track: AudioTrack): number {
  const t = track.originalTags;
  let score = 0;
  if (t?.artist?.trim()) score++;
  if (t?.albumArtist?.trim()) score++;
  if (t?.title?.trim()) score++;
  if (t?.album?.trim()) score++;
  if (t?.year?.trim()) score++;
  if (t?.trackNumber?.trim()) score++;
  if (t?.genre?.trim()) score++;
  if (t?.key?.trim()) score++;
  if (t?.bpm !== null && t?.bpm !== undefined) score++;
  if (track.cover?.embeddedBefore) score++;
  return score;
}

/**
 * Compares two candidate duplicate tracks to pick the preferred original:
 * 1. Higher codec/quality score (Lossless > Lossy; bit depth / sample rate)
 * 2. Tiebreaker 1: More complete tags
 * 3. Tiebreaker 2: Larger file size
 * 4. Tiebreaker 3: Older mtime (earlier original file wins)
 */
export function compareDuplicateCandidates(
  a: AudioTrack,
  b: AudioTrack
): { winner: AudioTrack; reason: DuplicateTiebreakerReason } {
  const qA = computeAudioQualityScore(a.codec, a.bitDepth, a.sampleRateHz, a.bitrateKbps);
  const qB = computeAudioQualityScore(b.codec, b.bitDepth, b.sampleRateHz, b.bitrateKbps);
  if (qA !== qB) {
    return { winner: qA > qB ? a : b, reason: 'higher_quality' };
  }

  const tagsA = countCompleteTags(a);
  const tagsB = countCompleteTags(b);
  if (tagsA !== tagsB) {
    return { winner: tagsA > tagsB ? a : b, reason: 'more_complete_tags' };
  }

  if (a.sizeBytes !== b.sizeBytes) {
    return { winner: a.sizeBytes > b.sizeBytes ? a : b, reason: 'larger_file_size' };
  }

  const mtimeA = Date.parse(a.mtimeIso || '') || 0;
  const mtimeB = Date.parse(b.mtimeIso || '') || 0;
  return { winner: mtimeA <= mtimeB ? a : b, reason: 'older_mtime' };
}

export interface DuplicateOverrides {
  decisions: Record<string, DuplicateDecision>;
  selectedOriginals: Record<string, string>;
}

/**
 * Classifies every track according to Points 1–11 & all refinements:
 * - Tracklist-based album protection & remix album preservation
 * - Precise DJ-Remix routing (keyword AND (confidence < threshold OR no MB match))
 * - No release match => all tracks in album get review_no_release_match (no auto-sort)
 * - Low confidence without remix keyword => review_low_confidence (not dj_remix)
 */
export function classifyAllTracks(
  tracks: AudioTrack[],
  config: PipelineConfig
): Map<
  string,
  {
    classification: TrackClassification;
    inTracklist: boolean;
    detachReason: string | null;
    isRemixAlbumTrack: boolean;
  }
> {
  const result = new Map<
    string,
    {
      classification: TrackClassification;
      inTracklist: boolean;
      detachReason: string | null;
      isRemixAlbumTrack: boolean;
    }
  >();

  // Group non-loose tracks by album tag + source dir
  const albumGroups = new Map<string, AudioTrack[]>();
  for (const track of tracks) {
    if (track.isLooseFile) continue;
    const key = `${normalizeTitleForMatch(track.album || track.originalTags?.album)}::${track.sourceDir || ''}`;
    const list = albumGroups.get(key) ?? [];
    list.push(track);
    albumGroups.set(key, list);
  }

  // Evaluate grouped albums first
  for (const [, groupTracks] of albumGroups) {
    // Pick matched release from tracks in this group that share a release
    const releaseCounts = new Map<string, { release: AlbumReleaseCandidate; count: number }>();
    for (const t of groupTracks) {
      if (t.matchedRelease && t.matchedRelease.releaseId) {
        const cur = releaseCounts.get(t.matchedRelease.releaseId);
        releaseCounts.set(t.matchedRelease.releaseId, {
          release: t.matchedRelease,
          count: (cur?.count ?? 0) + 1,
        });
      }
    }
    const dominantRelease =
      Array.from(releaseCounts.values()).sort((a, b) => b.count - a.count)[0]?.release ?? null;

    const wholeRemixAlbum = isWholeRemixAlbum(
      groupTracks[0]?.album || groupTracks[0]?.originalTags?.album || '',
      groupTracks,
      dominantRelease
    );

    for (const track of groupTracks) {
      // Handle explicit manual reassignment of review tracks first
      if (track.manualAssignment === 'album_track') {
        result.set(track.id, {
          classification: 'album_track',
          inTracklist: true,
          detachReason: null,
          isRemixAlbumTrack: wholeRemixAlbum,
        });
        continue;
      }
      if (track.manualAssignment === 'dj_remix') {
        result.set(track.id, {
          classification: 'dj_remix',
          inTracklist: false,
          detachReason: 'Manuell als DJ-Remix zugeordnet.',
          isRemixAlbumTrack: false,
        });
        continue;
      }

      const keywordInTitle = hasRemixKeyword(track.title || track.originalTags?.title);
      const lowConfidence = (track.acoustidConfidence ?? 0) < config.confidenceThreshold;
      const missingMb = !track.mbRecordingId;

      // Without a confident release match, never auto-sort the album: all tracks get review
      if (!dominantRelease) {
        result.set(track.id, {
          classification: 'review_no_release_match',
          inTracklist: false,
          detachReason: 'Kein sicheres MusicBrainz-Album-Release gefunden — manuelle Prüfung.',
          isRemixAlbumTrack: false,
        });
        continue;
      }

      const tracklistCheck = isTrackInReleaseTracklist(track, dominantRelease);

      // Official track on matched release (including official remixes & whole remix albums)
      if (tracklistCheck.matched || (wholeRemixAlbum && !lowConfidence && !missingMb)) {
        result.set(track.id, {
          classification: 'album_track',
          inTracklist: true,
          detachReason: null,
          isRemixAlbumTrack: wholeRemixAlbum,
        });
        continue;
      }

      // Not in matched release tracklist -> check DJ-Remix rule
      if (keywordInTitle && (lowConfidence || missingMb)) {
        result.set(track.id, {
          classification: 'dj_remix',
          inTracklist: false,
          detachReason: `Nicht in Trackliste von Release "${dominantRelease.title}" (${dominantRelease.trackCount} Tracks).`,
          isRemixAlbumTrack: false,
        });
        continue;
      }

      if (lowConfidence) {
        result.set(track.id, {
          classification: 'review_low_confidence',
          inTracklist: false,
          detachReason: `Konfidenz ${Math.round(track.acoustidConfidence * 100)} % unter Schwellwert (${Math.round(config.confidenceThreshold * 100)} %).`,
          isRemixAlbumTrack: false,
        });
        continue;
      }

      result.set(track.id, {
        classification: 'album_track',
        inTracklist: tracklistCheck.matched,
        detachReason: null,
        isRemixAlbumTrack: wholeRemixAlbum,
      });
    }
  }

  // Evaluate standalone / loose tracks
  for (const track of tracks) {
    if (result.has(track.id)) continue;

    if (track.manualAssignment === 'album_track') {
      result.set(track.id, {
        classification: 'album_track',
        inTracklist: true,
        detachReason: null,
        isRemixAlbumTrack: false,
      });
      continue;
    }
    if (track.manualAssignment === 'dj_remix') {
      result.set(track.id, {
        classification: 'dj_remix',
        inTracklist: false,
        detachReason: 'Manuell als DJ-Remix zugeordnet.',
        isRemixAlbumTrack: false,
      });
      continue;
    }

    const keywordInTitle = hasRemixKeyword(track.title || track.originalTags?.title);
    const lowConfidence = (track.acoustidConfidence ?? 0) < config.confidenceThreshold;
    const missingMb = !track.mbRecordingId;

    // Rule 1: DJ-Remix ONLY when keyword AND (low confidence OR no MB match)
    if (keywordInTitle && (lowConfidence || missingMb)) {
      result.set(track.id, {
        classification: 'dj_remix',
        inTracklist: false,
        detachReason: track.detachReason ?? 'Remix-/Bootleg-Stichwort ohne sicheren MusicBrainz-Treffer.',
        isRemixAlbumTrack: false,
      });
      continue;
    }

    // Rule 1: Low confidence without remix keyword => review only (stays out of DJ-Remixes)
    if (lowConfidence) {
      result.set(track.id, {
        classification: 'review_low_confidence',
        inTracklist: false,
        detachReason: `Konfidenz ${Math.round(track.acoustidConfidence * 100)} % unter Schwellwert (${Math.round(config.confidenceThreshold * 100)} %).`,
        isRemixAlbumTrack: false,
      });
      continue;
    }

    result.set(track.id, {
      classification: 'album_track',
      inTracklist: track.inMatchedReleaseTracklist,
      detachReason: null,
      isRemixAlbumTrack: false,
    });
  }

  return result;
}

/**
 * Album-aware Track Duplicate Detector (Points 4, 6, 8 & Refinement A):
 * - Matches via (a) MB Recording ID or AcoustID, (b) fallback normalized title + artist + duration ±2 s.
 * - DJ-Remixes exempt unless identical title including remix suffix AND duration ±2 s.
 * - Only duplicate for _Duplikate/ if:
 *   (a) same matched release, OR
 *   (b) both unmatched loose files, OR
 *   (exception) loose lossy file vs lossless file.
 * - Different matched releases (e.g. Studio Album vs Compilation) => "cross_album_notice" ONLY ("Auch auf Album X"), NO move recommendation!
 */
export function buildDuplicateGroups(
  tracks: AudioTrack[],
  classifications: Map<string, { classification: TrackClassification }>,
  trackCanonicalArtist: Map<string, string>,
  overrides: DuplicateOverrides = { decisions: {}, selectedOriginals: {} }
): DuplicateGroup[] {
  const buckets = new Map<
    string,
    { reason: DuplicateMatchReason; tracks: AudioTrack[] }
  >();

  for (const track of tracks) {
    const cls = classifications.get(track.id)?.classification ?? 'album_track';
    const isDj = cls === 'dj_remix';

    let key: string;
    let reason: DuplicateMatchReason;

    if (isDj) {
      // DJ-Remixes ONLY match another DJ-Remix with identical full title (incl. remix suffix) + duration ±2s
      const normFullTitle = normalizeTitleForMatch(track.title || track.originalTags?.title);
      const normArtist = normalizeArtistExact(track.artist || track.originalTags?.artist);
      const durBucket = Math.round((track.durationSec || 0) / 2);
      key = `dj:${normArtist}::${normFullTitle}::${durBucket}`;
      reason = 'normalized_title_artist_duration';
    } else if (track.mbRecordingId) {
      key = `mb:${track.mbRecordingId}`;
      reason = 'mb_recording_id';
    } else if (track.acoustidId) {
      key = `acoustid:${track.acoustidId}`;
      reason = 'acoustid_fingerprint';
    } else {
      const normTitle = normalizeTitleForMatch(track.title || track.originalTags?.title);
      const normArtist = normalizeArtistExact(track.artist || track.originalTags?.artist);
      const durBucket = Math.round((track.durationSec || 0) / 2);
      key = `fallback:${normArtist}::${normTitle}::${durBucket}`;
      reason = 'normalized_title_artist_duration';
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.tracks.push(track);
    } else {
      buckets.set(key, { reason, tracks: [track] });
    }
  }

  const groups: DuplicateGroup[] = [];

  for (const [bucketKey, bucket] of buckets) {
    if (bucket.tracks.length < 2) continue;

    // Partition into true duplicate groups vs cross-album notices
    const byRelease = new Map<string, AudioTrack[]>();
    const looseUnmatched: AudioTrack[] = [];

    for (const t of bucket.tracks) {
      if (t.matchedRelease && !t.isLooseFile) {
        const list = byRelease.get(t.matchedRelease.releaseId) ?? [];
        list.push(t);
        byRelease.set(t.matchedRelease.releaseId, list);
      } else {
        looseUnmatched.push(t);
      }
    }

    // 1. Same matched release duplicates (e.g. 24-bit FLAC + 16-bit FLAC on same album)
    //    AND loose lossy tracks that duplicate a lossless copy on a release
    const releaseEntries = Array.from(byRelease.entries());
    const hasAnyLosslessInBucket = bucket.tracks.some((t) => isLosslessCodec(t.codec));
    const looseLossyConsumed = new Set<string>();

    for (const [releaseId, relTracks] of releaseEntries) {
      const extraLooseLossy =
        hasAnyLosslessInBucket && relTracks.some((t) => isLosslessCodec(t.codec))
          ? looseUnmatched.filter(
              (lt) => !isLosslessCodec(lt.codec) && !looseLossyConsumed.has(lt.id)
            )
          : [];

      const combined = [...relTracks, ...extraLooseLossy];
      if (combined.length >= 2) {
        extraLooseLossy.forEach((lt) => looseLossyConsumed.add(lt.id));
        const scope: DuplicateScope =
          relTracks.length >= 2 ? 'same_release' : 'loose_lossy_vs_lossless';

        const ranked = [...combined].sort((a, b) => {
          const cmp = compareDuplicateCandidates(a, b);
          return cmp.winner.id === a.id ? -1 : 1;
        });

        const top = ranked[0];
        const second = ranked[1];
        const tiebreaker = compareDuplicateCandidates(top, second).reason;

        const groupId = `dup:${bucketKey}:${releaseId}`;
        const selectedOriginalId = overrides.selectedOriginals[groupId] ?? top.id;
        const decision: DuplicateDecision = overrides.decisions[groupId] ?? 'pending';

        groups.push({
          id: groupId,
          scope,
          matchReason: bucket.reason,
          tiebreakerReason: tiebreaker,
          canonicalArtist: trackCanonicalArtist.get(top.id) ?? top.albumArtist,
          title: top.title,
          trackIds: ranked.map((t) => t.id),
          recommendedOriginalId: top.id,
          selectedOriginalId,
          decision,
        });
      }
    }

    // 2. Remaining loose / unmatched duplicates (both unmatched OR loose lossy vs loose lossless)
    const remainingLoose = looseUnmatched.filter((lt) => !looseLossyConsumed.has(lt.id));
    if (remainingLoose.length >= 2) {
      const ranked = [...remainingLoose].sort((a, b) => {
        const cmp = compareDuplicateCandidates(a, b);
        return cmp.winner.id === a.id ? -1 : 1;
      });
      const top = ranked[0];
      const second = ranked[1];
      const tiebreaker = compareDuplicateCandidates(top, second).reason;
      const groupId = `dup:${bucketKey}:loose`;

      groups.push({
        id: groupId,
        scope: 'both_unmatched',
        matchReason: bucket.reason,
        tiebreakerReason: tiebreaker,
        canonicalArtist: trackCanonicalArtist.get(top.id) ?? top.albumArtist,
        title: top.title,
        trackIds: ranked.map((t) => t.id),
        recommendedOriginalId: top.id,
        selectedOriginalId: overrides.selectedOriginals[groupId] ?? top.id,
        decision: overrides.decisions[groupId] ?? 'pending',
      });
    }

    // 3. Cross-Album Notice (different matched releases e.g. Studio Album vs Compilation)
    //    STRICTLY informational ("Auch auf Album X"), NEVER a move recommendation!
    if (releaseEntries.length >= 2) {
      const representatives = releaseEntries.map(([, list]) => list[0]);
      const albumNames = representatives.map(
        (t) => t.matchedRelease?.title ?? t.album
      );
      const primary = representatives[0];
      const otherAlbums = albumNames.slice(1).join(', ');
      groups.push({
        id: `notice:${bucketKey}`,
        scope: 'cross_album_notice',
        matchReason: bucket.reason,
        tiebreakerReason: 'higher_quality',
        canonicalArtist: trackCanonicalArtist.get(primary.id) ?? primary.albumArtist,
        title: primary.title,
        trackIds: representatives.map((t) => t.id),
        recommendedOriginalId: primary.id,
        selectedOriginalId: primary.id,
        decision: 'keep_both',
        crossAlbumNote: `Auch auf Album „${otherAlbums}“ (verschiedene Releases — beide Alben bleiben unversehrt).`,
      });
    }
  }

  return groups;
}

/**
 * Evaluates the complete deterministic plan across all tracks, albums, artist clusters,
 * duplicate groups, companion files, collisions, and Mode 1 Analysis Report.
 */
export function evaluateLibraryPlan(
  tracks: AudioTrack[],
  companions: CompanionFile[],
  leftovers: LeftoverFile[],
  config: PipelineConfig,
  artistOverrides: ArtistResolutionOverrides,
  duplicateOverrides: DuplicateOverrides
): {
  artistClusters: ArtistCluster[];
  duplicateGroups: DuplicateGroup[];
  trackPlans: Map<string, EvaluatedTrackPlan>;
  evaluatedCompanions: CompanionFile[];
  effectiveLeftovers: LeftoverFile[];
  report: AnalysisReport;
} {
  const { clusters: artistClusters, trackCanonicalArtist, trackHasOpenConflict } =
    buildArtistClusters(tracks, artistOverrides);

  const classifications = classifyAllTracks(tracks, config);

  const duplicateGroups = buildDuplicateGroups(
    tracks,
    classifications,
    trackCanonicalArtist,
    duplicateOverrides
  );

  // Map duplicate tracks that will move to _Duplikate/
  const duplicateMoveTrackMap = new Map<string, string>(); // trackId -> groupId
  for (const group of duplicateGroups) {
    if (group.scope === 'cross_album_notice' || group.decision === 'keep_both') continue;
    for (const tid of group.trackIds) {
      if (tid !== group.selectedOriginalId) {
        duplicateMoveTrackMap.set(tid, group.id);
      }
    }
  }
  // Manual duplicate assignment on review tracks
  for (const track of tracks) {
    if (track.manualAssignment === 'duplicate') {
      duplicateMoveTrackMap.set(track.id, 'manual-duplicate');
    }
  }

  // Album-level quality classification (excluding detached foreign tracks & duplicates moving away)
  const albumBuckets = new Map<string, AudioTrack[]>();
  for (const track of tracks) {
    const cls = classifications.get(track.id)?.classification ?? 'album_track';
    if (cls !== 'album_track' || track.isLooseFile || duplicateMoveTrackMap.has(track.id)) {
      continue;
    }
    const albumKey = track.matchedRelease?.releaseId
      ? `rel:${track.matchedRelease.releaseId}`
      : `alb:${normalizeTitleForMatch(track.album || track.originalTags?.album)}::${track.sourceDir || ''}`;
    const list = albumBuckets.get(albumKey) ?? [];
    list.push(track);
    albumBuckets.set(albumKey, list);
  }

  const albumQualityMap = new Map<string, { tier: QualityTier; isMixed: boolean }>();
  for (const [albumKey, albumTracks] of albumBuckets) {
    const tiers = new Set<QualityTier>();
    for (const t of albumTracks) {
      tiers.add(
        classifyCodecQuality(
          t.codec,
          t.bitrateKbps,
          config.minLossyBitrateKbps,
          config.separateLowQualityLossy
        )
      );
    }
    const isMixed = tiers.size > 1;
    let resolvedTier: QualityTier = 'lossless';
    if (tiers.has('lossy_low')) {
      resolvedTier = 'lossy_low';
    } else if (tiers.has('lossy_high')) {
      resolvedTier = 'lossy_high';
    }
    albumQualityMap.set(albumKey, { tier: resolvedTier, isMixed });
  }

  // Build preliminary target paths for every track
  const rawPlans: Array<{
    track: AudioTrack;
    plan: Omit<EvaluatedTrackPlan, 'collision' | 'collisionDetail'>;
    tooLong: boolean;
  }> = [];

  for (const track of tracks) {
    const codecQuality = classifyCodecQuality(
      track.codec,
      track.bitrateKbps,
      config.minLossyBitrateKbps,
      config.separateLowQualityLossy
    );
    const clsInfo = classifications.get(track.id) ?? {
      classification: 'album_track' as TrackClassification,
      inTracklist: true,
      detachReason: null,
      isRemixAlbumTrack: false,
    };

    const resolvedAlbumArtist =
      track.compilationFlag
        ? 'Various Artists'
        : trackCanonicalArtist.get(track.id) ?? track.albumArtist;

    const hasOpenArtistConflict = trackHasOpenConflict.get(track.id) ?? false;
    const isDuplicateToMove = duplicateMoveTrackMap.has(track.id);
    const duplicateGroupId = duplicateMoveTrackMap.get(track.id) ?? null;

    const albumKey = track.matchedRelease?.releaseId
      ? `rel:${track.matchedRelease.releaseId}`
      : `alb:${normalizeTitleForMatch(track.album || track.originalTags?.album)}::${track.sourceDir || ''}`;
    const albumMeta = albumQualityMap.get(albumKey);

    const albumQuality =
      clsInfo.classification === 'album_track' && !track.isLooseFile && albumMeta
        ? albumMeta.tier
        : codecQuality;
    const isMixedAlbum =
      clsInfo.classification === 'album_track' && !track.isLooseFile && Boolean(albumMeta?.isMixed);

    const isReview =
      clsInfo.classification === 'review_low_confidence' ||
      clsInfo.classification === 'review_no_release_match';

    // Determine Mode 2 tagging behavior
    const willSkipInMode2 =
      hasOpenArtistConflict ||
      isReview ||
      ((track.acoustidConfidence ?? 0) < config.confidenceThreshold &&
        clsInfo.classification !== 'dj_remix' &&
        track.manualAssignment === 'none');

    let skipMode2Reason: string | null = null;
    if (hasOpenArtistConflict) {
      skipMode2Reason = 'Offener Künstlerkonflikt (needs_review) — in Modus 2 übersprungen.';
    } else if (isReview) {
      skipMode2Reason =
        clsInfo.classification === 'review_no_release_match'
          ? 'Kein sicheres Album-Release — bleibt im Review-Status ungetaggt.'
          : `Konfidenz unter ${Math.round(config.confidenceThreshold * 100)} % — Tags werden nicht überschrieben.`;
    }

    // DJ-Remix: Artist & Title NEVER overwritten; empty Key/BPM/ReplayGain/Cover enrichable when config ON
    const willEnrichRemixEmptyFields: string[] = [];
    if (clsInfo.classification === 'dj_remix' && config.enrichRemixEmptyFields) {
      if (!track.originalTags?.key && config.enableEssentia && config.essentiaAvailable) {
        willEnrichRemixEmptyFields.push('Key');
      }
      if (
        (track.originalTags?.bpm === null || track.originalTags?.bpm === undefined) &&
        config.enableEssentia &&
        config.essentiaAvailable
      ) {
        willEnrichRemixEmptyFields.push('BPM');
      }
      if (config.writeReplayGain) {
        willEnrichRemixEmptyFields.push('ReplayGain');
      }
      if (
        !track.cover?.embeddedBefore &&
        config.embedCover &&
        track.cover &&
        track.cover.status !== 'missing'
      ) {
        willEnrichRemixEmptyFields.push('Cover');
      }
    }

    const willOverwriteCoreTags =
      !willSkipInMode2 && clsInfo.classification !== 'dj_remix' && !isDuplicateToMove;

    const wavMediaSkipped = isWavCodec(track.codec, track.extension) && !config.wavEmbedMedia;

    // Build target path per rules
    let targetRelativePath = String(track.sourceRelativePath ?? track.fileName ?? '');
    let sanitizedChanged = false;
    let tooLong = false;

    const paddedTrack = track.trackNumber
      ? String(track.trackNumber).padStart(2, '0')
      : '';
    const fileStem =
      clsInfo.classification === 'dj_remix'
        ? `${track.originalTags?.artist || track.artist || 'Unbekannt'} - ${track.originalTags?.title || track.title || 'Unbekannt'}`
        : paddedTrack
          ? `${paddedTrack} - ${track.title || 'Unbekannt'}`
          : `${track.artist || 'Unbekannt'} - ${track.title || 'Unbekannt'}`;

    if (isDuplicateToMove) {
      const san = sanitizeRelativePath(
        ['_Duplikate', resolvedAlbumArtist],
        `${track.title || 'Unbekannt'} [${String(track.codec || 'audio').toUpperCase()} ${track.bitrateKbps || 0}k]`,
        track.extension,
        config.maxPathLength
      );
      targetRelativePath = san.relativePath;
      sanitizedChanged = san.changed;
      tooLong = san.tooLong;
    } else if (isReview) {
      if (config.keepReviewTracksInPlace) {
        targetRelativePath = String(track.sourceRelativePath ?? track.fileName ?? '');
      } else {
        // Quality-split _Review/Lossless/{relPath} or _Review/Lossy/{relPath} per Codec
        const reviewBucket = isLosslessCodec(track.codec) ? 'Lossless' : 'Lossy';
        const parts = String(track.sourceRelativePath ?? track.fileName ?? '').split('/').filter(Boolean);
        const origFile = parts.pop() ?? track.fileName ?? 'Unbekannt';
        if (parts[0] === '_Review' && (parts[1] === 'Lossless' || parts[1] === 'Lossy')) {
          parts.splice(0, 2);
        }
        const origStem = origFile.replace(/\.[^.]+$/, '');
        const san = sanitizeRelativePath(
          ['_Review', reviewBucket, ...parts],
          origStem,
          track.extension,
          config.maxPathLength
        );
        targetRelativePath = san.relativePath;
        sanitizedChanged = san.changed;
        tooLong = san.tooLong;
      }
    } else if (clsInfo.classification === 'dj_remix') {
      const djArtist = track.originalTags?.albumArtist || resolvedAlbumArtist;
      const segments =
        config.djRemixLayout === 'root_folder'
          ? ['DJ-Remixes', djArtist]
          : [isLosslessCodec(track.codec) ? 'Lossless' : 'Lossy', 'DJ-Remixes', djArtist];
      const san = sanitizeRelativePath(segments, fileStem, track.extension, config.maxPathLength);
      targetRelativePath = san.relativePath;
      sanitizedChanged = san.changed;
      tooLong = san.tooLong;
    } else {
      // Regular Album Track / Compilation / Loose Confident Track
      const rootSegments =
        albumQuality === 'lossless'
          ? ['Lossless']
          : albumQuality === 'lossy_low' && config.separateLowQualityLossy
            ? ['Lossy', 'Low-Quality']
            : ['Lossy'];

      const albumFolder = track.year ? `${track.year} - ${track.album}` : track.album;
      const segments = track.compilationFlag
        ? [...rootSegments, 'Various Artists', albumFolder]
        : track.isLooseFile
          ? [...rootSegments, resolvedAlbumArtist, 'Singles & Lose Tracks']
          : [...rootSegments, resolvedAlbumArtist, albumFolder];

      const san = sanitizeRelativePath(segments, fileStem, track.extension, config.maxPathLength);
      targetRelativePath = san.relativePath;
      sanitizedChanged = san.changed;
      tooLong = san.tooLong;
    }

    rawPlans.push({
      track,
      tooLong,
      plan: {
        trackId: track.id,
        codecQuality,
        albumQuality,
        isMixedAlbum,
        classification: clsInfo.classification,
        resolvedAlbumArtist,
        hasOpenArtistConflict,
        willSkipInMode2,
        skipMode2Reason,
        willOverwriteCoreTags,
        willEnrichRemixEmptyFields,
        wavMediaSkipped,
        isDuplicateToMove,
        duplicateGroupId,
        targetRelativePath,
        sanitizedChanged,
      },
    });
  }

  // Deterministically disambiguate colliding/too-long paths with "(2)", "(3)" suffixes (never overwrite)
  const uniquePaths = ensureUniqueRelativePaths(
    rawPlans.map((r) => ({
      id: r.track.id,
      targetRelativePath: r.plan.targetRelativePath,
      tooLong: r.tooLong,
    })),
    config.maxPathLength,
    config.smbCaseSafe
  );
  for (const r of rawPlans) {
    const resolved = uniquePaths.get(r.track.id);
    if (resolved) {
      if (resolved.changed) {
        r.plan.targetRelativePath = resolved.targetRelativePath;
        r.plan.sanitizedChanged = true;
      }
      r.tooLong = resolved.tooLong;
    }
  }

  // Run exact & SMB case-insensitive collision detection across all resolved planned paths
  const collisions = detectPathCollisions(
    rawPlans.map((r) => ({
      id: r.track.id,
      targetRelativePath: r.plan.targetRelativePath,
      tooLong: r.tooLong,
    })),
    config.smbCaseSafe
  );

  const trackPlans = new Map<string, EvaluatedTrackPlan>();
  for (const r of rawPlans) {
    const col = collisions.get(r.track.id) ?? { type: 'none' as const, detail: null };
    trackPlans.set(r.track.id, {
      ...r.plan,
      collision: col.type,
      collisionDetail: col.detail,
    });
  }

  // Resolve companion file target folders from their parent album's resolved directory
  // Prioritize album_track folders, then fall back to dj_remix or moved _Review folders so old dirs can empty cleanly
  const sourceDirToTargetDir = new Map<string, string>();
  for (const track of tracks) {
    const plan = trackPlans.get(track.id);
    if (!plan || plan.classification !== 'album_track' || plan.isDuplicateToMove) continue;
    const targetDir = plan.targetRelativePath.split('/').slice(0, -1).join('/');
    if (targetDir && !sourceDirToTargetDir.has(track.sourceDir)) {
      sourceDirToTargetDir.set(track.sourceDir, targetDir);
    }
  }
  for (const track of tracks) {
    if (sourceDirToTargetDir.has(track.sourceDir)) continue;
    const plan = trackPlans.get(track.id);
    if (!plan || plan.isDuplicateToMove) continue;
    if (
      plan.classification === 'dj_remix' ||
      (!config.keepReviewTracksInPlace &&
        (plan.classification === 'review_low_confidence' ||
          plan.classification === 'review_no_release_match'))
    ) {
      const targetDir = plan.targetRelativePath.split('/').slice(0, -1).join('/');
      if (targetDir) {
        sourceDirToTargetDir.set(track.sourceDir, targetDir);
      }
    }
  }

  const evaluatedCompanions = companions.map((c) => {
    const targetDir = sourceDirToTargetDir.get(c.sourceDir);
    return {
      ...c,
      targetPath: config.moveCompanionFiles && targetDir ? `${targetDir}/${c.fileName}` : null,
    };
  });

  // Leftovers include videos/other + any review tracks left in place when checkbox is enabled
  const effectiveLeftovers: LeftoverFile[] = [...leftovers];
  if (config.keepReviewTracksInPlace) {
    for (const track of tracks) {
      const plan = trackPlans.get(track.id);
      if (
        plan &&
        (plan.classification === 'review_low_confidence' ||
          plan.classification === 'review_no_release_match')
      ) {
        effectiveLeftovers.push({
          id: `review-left:${track.id}`,
          sourceRelativePath: track.sourceRelativePath,
          sourceDir: track.sourceDir,
          fileName: track.fileName,
          kind: 'review_left_in_place',
          reason: 'Review-Track laut Option unverändert am Ursprungsort belassen.',
          sizeBytes: track.sizeBytes,
        });
      }
    }
  }

  // Build Mode 1 Analysis Report
  let losslessCount = 0;
  let lossyHighCount = 0;
  let lossyLowCount = 0;
  let fakeFlacWarningCount = 0;
  let djRemixCount = 0;
  let reviewLosslessCount = 0;
  let reviewLossyCount = 0;
  let detachedForeignTrackCount = 0;
  let skippedInMode2ArtistConflictCount = 0;
  let pathCollisionCount = 0;
  const mixedAlbumDirs = new Set<string>();

  for (const track of tracks) {
    const plan = trackPlans.get(track.id)!;
    if (plan.codecQuality === 'lossless') losslessCount++;
    else if (plan.codecQuality === 'lossy_high') lossyHighCount++;
    else lossyLowCount++;

    if (track.spectralWarningOnly && config.enableEssentia && config.essentiaAvailable) {
      fakeFlacWarningCount++;
    }
    if (plan.classification === 'dj_remix') djRemixCount++;
    if (
      plan.classification === 'review_low_confidence' ||
      plan.classification === 'review_no_release_match'
    ) {
      if (isLosslessCodec(track.codec)) reviewLosslessCount++;
      else reviewLossyCount++;
    }
    if (plan.isMixedAlbum) mixedAlbumDirs.add(track.sourceDir);
    if (track.detachedFromAlbum) detachedForeignTrackCount++;
    if (plan.hasOpenArtistConflict) skippedInMode2ArtistConflictCount++;
    if (plan.collision !== 'none') pathCollisionCount++;
  }

  const activeDupGroups = duplicateGroups.filter((g) => g.scope !== 'cross_album_notice');
  const crossAlbumNotices = duplicateGroups.filter((g) => g.scope === 'cross_album_notice');
  const duplicateMoveCount = Array.from(trackPlans.values()).filter(
    (p) => p.isDuplicateToMove
  ).length;
  const openArtistConflictCount = artistClusters.filter(
    (c) => c.status === 'needs_review'
  ).length;

  const report: AnalysisReport = {
    totalAudioTracks: tracks.length,
    losslessCount,
    lossyHighCount,
    lossyLowCount,
    duplicateGroupCount: activeDupGroups.length,
    duplicateMoveCount,
    crossAlbumNoticeCount: crossAlbumNotices.length,
    fakeFlacWarningCount,
    djRemixCount,
    reviewLosslessCount,
    reviewLossyCount,
    mixedAlbumCount: mixedAlbumDirs.size,
    detachedForeignTrackCount,
    openArtistConflictCount,
    skippedInMode2ArtistConflictCount,
    pathCollisionCount,
    companionFileCount: evaluatedCompanions.length,
    untouchedVideoAndLeftoverCount: effectiveLeftovers.length,
  };

  return {
    artistClusters,
    duplicateGroups,
    trackPlans,
    evaluatedCompanions,
    effectiveLeftovers,
    report,
  };
}

export interface NextModeAction {
  mode: 'analyze' | 'tag' | 'move' | 'rerun' | 'done';
  label: string;
  enabled: boolean;
  blockReason: string | null;
}

/**
 * Computes the single primary Top-Bar action button according to Mode 1 -> Mode 2 -> Mode 3
 * and targeted Re-Run (Mode 2 + Mode 3 for manually reassigned review tracks):
 * - Mode 2 unlocks as soon as Mode 1 is completed (skips open artist conflict tracks).
 * - Mode 3 unlocks ONLY when Mode 2 is completed AND 0 open needs_review artist conflicts AND 0 path collisions.
 * - Re-Run unlocks whenever Mode 3 has run (or review tracks were manually reassigned).
 */
export function computeNextModeAction(params: {
  mode1Completed: boolean;
  mode2Completed: boolean;
  mode3Completed: boolean;
  openArtistConflictCount: number;
  pathCollisionCount: number;
  pendingReRunCount: number;
  queueRunningOrPaused: boolean;
  hasInterruptedJournal: boolean;
  totalTracks?: number;
  backendConnected?: boolean;
}): NextModeAction {
  if (params.hasInterruptedJournal) {
    return {
      mode: 'move',
      label: 'Wiederherstellung erforderlich',
      enabled: false,
      blockReason: 'Bitte abgebrochenen Lauf im Banner fortsetzen oder zurückrollen.',
    };
  }

  if (params.queueRunningOrPaused) {
    return {
      mode: 'analyze',
      label: 'Queue aktiv …',
      enabled: false,
      blockReason: 'Hintergrund-Queue läuft oder ist pausiert.',
    };
  }

  if (params.totalTracks === 0) {
    if (params.backendConnected) {
      return {
        mode: 'analyze',
        label: 'Modus 1: Bibliothek scannen & analysieren',
        enabled: true,
        blockReason: null,
      };
    }
    return {
      mode: 'analyze',
      label: 'Keine Dateien geladen',
      enabled: false,
      blockReason:
        'Bitte zuerst das TonArchiv Docker-Backend verbinden oder einen lokalen Musikordner einlesen.',
    };
  }

  const canWriteFs = params.backendConnected !== false;

  if (params.mode3Completed && params.pendingReRunCount > 0) {
    return {
      mode: 'rerun',
      label: `Re-Run: Taggen & verschieben (${params.pendingReRunCount})`,
      enabled: canWriteFs && params.openArtistConflictCount === 0 && params.pathCollisionCount === 0,
      blockReason: !canWriteFs
        ? 'Schreibzugriff erfordert das verbundene TonArchiv Docker-Backend.'
        : params.openArtistConflictCount > 0
          ? 'Bitte zuerst offene Künstlerkonflikte lösen.'
          : params.pathCollisionCount > 0
            ? 'Bitte zuerst Pfadkollisionen beheben.'
            : null,
    };
  }

  if (!params.mode1Completed) {
    return {
      mode: 'analyze',
      label: 'Modus 1: Nur analysieren',
      enabled: true,
      blockReason: null,
    };
  }

  if (!params.mode2Completed) {
    if (!canWriteFs) {
      return {
        mode: 'tag',
        label: 'Modus 2: Taggen (Docker-Backend nötig)',
        enabled: false,
        blockReason:
          'Schreiben von Tags, Cover & Lyrics in Originaldateien erfordert den verbundenen TonArchiv FastAPI-Container.',
      };
    }
    return {
      mode: 'tag',
      label: 'Modus 2: Taggen',
      enabled: true,
      blockReason: null,
    };
  }

  if (!params.mode3Completed) {
    if (!canWriteFs) {
      return {
        mode: 'move',
        label: 'Modus 3: Verschieben (Docker-Backend nötig)',
        enabled: false,
        blockReason:
          'Atomares Verschieben und Aufräumen erfordert den verbundenen TonArchiv FastAPI-Container.',
      };
    }
    if (params.openArtistConflictCount > 0) {
      return {
        mode: 'move',
        label: 'Modus 3: Verschieben & aufräumen',
        enabled: false,
        blockReason: `${params.openArtistConflictCount} offene Künstlerkonflikte (needs_review) blockieren Modus 3.`,
      };
    }
    if (params.pathCollisionCount > 0) {
      return {
        mode: 'move',
        label: 'Modus 3: Verschieben & aufräumen',
        enabled: false,
        blockReason: `${params.pathCollisionCount} Pfad-/SMB-Kollision(en) müssen vor dem Verschieben gelöst werden.`,
      };
    }
    return {
      mode: 'move',
      label: 'Modus 3: Verschieben & aufräumen',
      enabled: true,
      blockReason: null,
    };
  }

  return {
    mode: 'done',
    label: 'Lauf abgeschlossen',
    enabled: false,
    blockReason: 'Alle drei Modi wurden erfolgreich abgeschlossen.',
  };
}
