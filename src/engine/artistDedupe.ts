import {
  ArtistCluster,
  ArtistClusterRule,
  ArtistClusterStatus,
  AudioTrack,
} from '../types/tonarchiv';

/**
 * Known standalone artists in MusicBrainz whose names contain "&", ",", or "vs."
 * and MUST NEVER be split during albumArtist canonicalization.
 */
export const PROTECTED_MBID_ARTISTS: ReadonlyMap<
  string,
  { canonicalName: string; mbArtistId: string }
> = new Map([
  [
    'simon & garfunkel',
    {
      canonicalName: 'Simon & Garfunkel',
      mbArtistId: '5d02f264-e225-41ff-83f7-d9b1f0b18745',
    },
  ],
  [
    'earth, wind & fire',
    {
      canonicalName: 'Earth, Wind & Fire',
      mbArtistId: '535afeda-2538-435d-9d1e-4e80dd5d8a9e',
    },
  ],
  [
    'tyler, the creator',
    {
      canonicalName: 'Tyler, The Creator',
      mbArtistId: 'f6beac20-5dfe-4d1f-ae02-0b0a740aafd6',
    },
  ],
  [
    'years & years',
    {
      canonicalName: 'Years & Years',
      mbArtistId: '58927512-40a2-49b4-82c5-2041f648e94c',
    },
  ],
  [
    'above & beyond',
    {
      canonicalName: 'Above & Beyond',
      mbArtistId: '18f14734-0001-4382-846f-5c9b044959c0',
    },
  ],
  [
    'chase & status',
    {
      canonicalName: 'Chase & Status',
      mbArtistId: 'c37f4b23-891c-4a64-856e-a0a64053a7a0',
    },
  ],
  [
    'florence + the machine',
    {
      canonicalName: 'Florence + the Machine',
      mbArtistId: '5fee3020-513b-48c2-b1f7-4681b01db0c6',
    },
  ],
]);

/**
 * Strips diacritics, normalizes Unicode NFC/NFD, collapses whitespace, and lowercases
 * for exact normalization comparisons (never fuzzy).
 */
export function normalizeArtistExact(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts folder-level ALBUMARTIST safely:
 * 1. Always strips feat./ft./featuring suffixes.
 * 2. Splits "&", ",", "vs." ONLY when the full artist name does NOT exist as a standalone MBID artist.
 * 3. Preserves "Various Artists" for compilations.
 */
export function extractCanonicalAlbumArtist(
  rawAlbumArtist: string | null | undefined,
  mbArtistId: string | null,
  isCompilation: boolean
): {
  canonical: string;
  wasProtectedBand: boolean;
  strippedFeature: boolean;
} {
  const trimmed = String(rawAlbumArtist ?? '').normalize('NFC').trim();
  if (
    isCompilation ||
    normalizeArtistExact(trimmed) === 'various artists' ||
    normalizeArtistExact(trimmed) === 'diverse'
  ) {
    return {
      canonical: 'Various Artists',
      wasProtectedBand: false,
      strippedFeature: false,
    };
  }

  // Step 1: Always strip feat./ft./featuring
  const featRegex = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i;
  const strippedFeature = featRegex.test(trimmed);
  const withoutFeat = trimmed.replace(featRegex, '').trim();

  // Step 2: Check MBID-protected standalone band names before touching &, ,, vs.
  const exactKey = normalizeArtistExact(withoutFeat);
  const protectedEntry = PROTECTED_MBID_ARTISTS.get(exactKey);
  if (protectedEntry) {
    return {
      canonical: protectedEntry.canonicalName,
      wasProtectedBand: true,
      strippedFeature,
    };
  }

  // If the full string itself already has a verified MBID and contains &, ,, vs., protect it
  if (mbArtistId && /[&,]|\bvs\.?\b/i.test(withoutFeat)) {
    const knownByMbid = Array.from(PROTECTED_MBID_ARTISTS.values()).find(
      (entry) => entry.mbArtistId === mbArtistId
    );
    if (knownByMbid) {
      return {
        canonical: knownByMbid.canonicalName,
        wasProtectedBand: true,
        strippedFeature,
      };
    }
  }

  // Step 3: Split "&", ",", "vs." only if NOT a protected standalone artist
  const collabSplitRegex = /\s+(?:&|vs\.?)\s+|,\s+/i;
  if (collabSplitRegex.test(withoutFeat)) {
    const primary = withoutFeat.split(collabSplitRegex)[0]?.trim();
    if (primary) {
      return {
        canonical: primary,
        wasProtectedBand: false,
        strippedFeature: true,
      };
    }
  }

  return {
    canonical: withoutFeat || 'Unbekannter Künstler',
    wasProtectedBand: false,
    strippedFeature,
  };
}

/**
 * Fast 1D-buffer Levenshtein distance with optional maxDist early exit (zero 2D matrix allocations).
 */
export function levenshteinDistance(a: string, b: string, maxDist?: number): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (maxDist !== undefined && Math.abs(m - n) > maxDist) {
    return maxDist + 1;
  }

  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const chA = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = chA === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const best = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (maxDist !== undefined && rowMin > maxDist) {
      return maxDist + 1;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function computeArtistSimilarityPrecomputed(
  na: string,
  tokensA: string[],
  setA: ReadonlySet<string>,
  nb: string,
  tokensB: string[],
  setB: ReadonlySet<string>
): number {
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);

  // Token containment for prefix/suffix variants like "DJ Tiesto" vs "Tiesto"
  const minTokens = Math.min(setA.size, setB.size);
  let tokenContainSim = 0;
  if (minTokens > 0 && Math.max(setA.size, setB.size) <= minTokens + 1) {
    let intersection = 0;
    for (let k = 0; k < tokensA.length; k++) {
      if (setB.has(tokensA[k])) intersection++;
    }
    if (intersection === minTokens) {
      tokenContainSim = 0.84;
    }
  }

  if (Math.abs(na.length - nb.length) / maxLen > 0.25) {
    return tokenContainSim;
  }

  const maxAllowedDist = Math.ceil(maxLen * 0.25);
  const dist = levenshteinDistance(na, nb, maxAllowedDist);
  const levSim = dist > maxAllowedDist ? 0 : 1 - dist / maxLen;

  return Number(Math.max(levSim, tokenContainSim).toFixed(3));
}

export function computeArtistSimilarity(a: string, b: string): number {
  const na = normalizeArtistExact(a).replace(/[^a-z0-9 ]/g, '').trim();
  const nb = normalizeArtistExact(b).replace(/[^a-z0-9 ]/g, '').trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const tokensA = na.split(' ').filter(Boolean);
  const tokensB = nb.split(' ').filter(Boolean);
  return computeArtistSimilarityPrecomputed(
    na,
    tokensA,
    new Set(tokensA),
    nb,
    tokensB,
    new Set(tokensB)
  );
}

export interface ArtistResolutionOverrides {
  // clusterId -> user status ('user_confirmed' | 'split_kept')
  decisions: Record<string, ArtistClusterStatus>;
  // clusterId -> custom canonical name
  renamedCanonical: Record<string, string>;
}

/**
 * Builds conservative artist clusters strictly from ALBUMARTIST (never track artist):
 * - Auto-merge ONLY on (a) same MBID or (b) exact normalization (case/diacritics/Unicode).
 * - Fuzzy similarity strictly emits "needs_review" suggestions and NEVER auto-merges.
 * - Protected MBID bands (&, ,, vs.) and Various Artists compilations are surfaced clearly.
 */
export function buildArtistClusters(
  tracks: AudioTrack[],
  overrides: ArtistResolutionOverrides = { decisions: {}, renamedCanonical: {} }
): {
  clusters: ArtistCluster[];
  trackCanonicalArtist: Map<string, string>;
  trackHasOpenConflict: Map<string, boolean>;
} {
  interface RawGroup {
    key: string;
    canonicalName: string;
    mbArtistId: string | null;
    variants: Set<string>;
    trackIds: string[];
    rule: ArtistClusterRule;
    wasProtectedBand: boolean;
    isCompilation: boolean;
  }

  const byMbid = new Map<string, RawGroup>();
  const byExact = new Map<string, RawGroup>();
  const allGroups: RawGroup[] = [];

  for (const track of tracks) {
    const rawAlbumArtist = track.albumArtist || track.originalTags?.albumArtist || track.artist || '';
    const extracted = extractCanonicalAlbumArtist(
      rawAlbumArtist,
      track.mbArtistId,
      track.compilationFlag
    );
    const exactKey = normalizeArtistExact(extracted.canonical);

    let group: RawGroup | undefined;
    if (track.compilationFlag || exactKey === 'various artists') {
      group = byExact.get('various artists');
      if (!group) {
        group = {
          key: 'va',
          canonicalName: 'Various Artists',
          mbArtistId: '89ad4ac3-39f7-470e-963a-56509c546377',
          variants: new Set([rawAlbumArtist]),
          trackIds: [],
          rule: 'compilation_va',
          wasProtectedBand: false,
          isCompilation: true,
        };
        byExact.set('various artists', group);
        allGroups.push(group);
      }
      group.variants.add(rawAlbumArtist);
      group.trackIds.push(track.id);
      continue;
    }

    if (track.mbArtistId && byMbid.has(track.mbArtistId)) {
      group = byMbid.get(track.mbArtistId)!;
      group.variants.add(rawAlbumArtist);
      group.trackIds.push(track.id);
      // Prefer variant with proper casing / diacritics if available
      if (
        extracted.canonical !== group.canonicalName &&
        /[À-ž]/.test(extracted.canonical) &&
        !/[À-ž]/.test(group.canonicalName)
      ) {
        group.canonicalName = extracted.canonical;
      }
      continue;
    }

    if (byExact.has(exactKey)) {
      group = byExact.get(exactKey)!;
      group.variants.add(rawAlbumArtist);
      group.trackIds.push(track.id);
      if (!group.mbArtistId && track.mbArtistId) {
        group.mbArtistId = track.mbArtistId;
        byMbid.set(track.mbArtistId, group);
      }
      // Prefer diacritic / capitalized spelling
      if (
        /[À-ž]/.test(extracted.canonical) &&
        !/[À-ž]/.test(group.canonicalName)
      ) {
        group.canonicalName = extracted.canonical;
      } else if (
        group.canonicalName === group.canonicalName.toLowerCase() &&
        extracted.canonical !== extracted.canonical.toLowerCase()
      ) {
        group.canonicalName = extracted.canonical;
      }
      continue;
    }

    const rule: ArtistClusterRule = extracted.wasProtectedBand
      ? 'protected_band'
      : track.mbArtistId
        ? 'mbid_exact'
        : 'exact_normalization';

    group = {
      key: track.mbArtistId ? `mbid:${track.mbArtistId}` : `exact:${exactKey}`,
      canonicalName: extracted.canonical,
      mbArtistId: track.mbArtistId,
      variants: new Set([rawAlbumArtist]),
      trackIds: [track.id],
      rule,
      wasProtectedBand: extracted.wasProtectedBand,
      isCompilation: false,
    };

    byExact.set(exactKey, group);
    if (track.mbArtistId) {
      byMbid.set(track.mbArtistId, group);
    }
    allGroups.push(group);
  }

  // Precompute normalized forms & candidate inverted index (tokens + prefix/suffix/3-grams)
  // so fuzzy matching stays near-linear even for 2,000+ unique artists on mobile devices.
  const precomputed = allGroups.map((g) => {
    const exact = normalizeArtistExact(g.canonicalName);
    const clean = exact.replace(/[^a-z0-9 ]/g, '').trim();
    const tokens = clean ? clean.split(' ').filter(Boolean) : [];
    const tokenSet = new Set(tokens);
    return { exact, clean, tokens, tokenSet };
  });

  const candidateIndex = new Map<string, number[]>();
  const addKey = (k: string, idx: number) => {
    let bucket = candidateIndex.get(k);
    if (!bucket) {
      bucket = [];
      candidateIndex.set(k, bucket);
    }
    // Cap ultra-generic buckets (e.g. "the", "dj") to prevent quadratic blow-up
    if (bucket.length < 80) {
      bucket.push(idx);
    }
  };

  for (let i = 0; i < allGroups.length; i++) {
    const g = allGroups[i];
    if (g.isCompilation || g.wasProtectedBand) continue;
    const { clean, tokens } = precomputed[i];
    if (!clean) continue;
    addKey(`c:${clean}`, i);
    for (const tok of tokens) {
      if (tok.length >= 2) addKey(`t:${tok}`, i);
    }
    const compact = clean.replace(/\s+/g, '');
    if (compact.length >= 3) {
      const half = Math.floor(compact.length / 2);
      addKey(`p:${compact.slice(0, Math.min(4, Math.max(2, half)))}`, i);
      addKey(`s:${compact.slice(-Math.min(4, Math.max(2, compact.length - half)))}`, i);
    }
  }

  // Detect conservative fuzzy pairs (ONLY between groups that did NOT already merge via MBID/exact)
  // NEVER auto-merges: strictly creates a needs_review suggestion!
  const consumedIntoFuzzy = new Set<string>();
  const clusters: ArtistCluster[] = [];

  for (let i = 0; i < allGroups.length; i++) {
    const gA = allGroups[i];
    if (consumedIntoFuzzy.has(gA.key)) continue;

    if (!gA.isCompilation && !gA.wasProtectedBand) {
      const pA = precomputed[i];
      let fuzzyPartner: RawGroup | null = null;
      let bestSim = 0;

      // Gather only indexed candidate partner indices j > i
      const candidateSet = new Set<number>();
      if (pA.clean) {
        const collect = (k: string) => {
          const list = candidateIndex.get(k);
          if (!list) return;
          for (let b = 0; b < list.length; b++) {
            const j = list[b];
            if (j > i) candidateSet.add(j);
          }
        };
        collect(`c:${pA.clean}`);
        for (const tok of pA.tokens) {
          if (tok.length >= 2) collect(`t:${tok}`);
        }
        const compact = pA.clean.replace(/\s+/g, '');
        if (compact.length >= 3) {
          const half = Math.floor(compact.length / 2);
          collect(`p:${compact.slice(0, Math.min(4, Math.max(2, half)))}`);
          collect(`s:${compact.slice(-Math.min(4, Math.max(2, compact.length - half)))}`);
        }
      }

      for (const j of candidateSet) {
        const gB = allGroups[j];
        if (consumedIntoFuzzy.has(gB.key) || gB.isCompilation || gB.wasProtectedBand) continue;
        // If both have DIFFERENT confirmed MBIDs, they are distinct artists — never suggest merge
        if (gA.mbArtistId && gB.mbArtistId && gA.mbArtistId !== gB.mbArtistId) continue;

        const pB = precomputed[j];
        if (pA.exact === pB.exact) continue;

        const sim = computeArtistSimilarityPrecomputed(
          pA.clean,
          pA.tokens,
          pA.tokenSet,
          pB.clean,
          pB.tokens,
          pB.tokenSet
        );
        if (sim >= 0.78 && sim > bestSim) {
          bestSim = sim;
          fuzzyPartner = gB;
        }
      }

      if (fuzzyPartner) {
        consumedIntoFuzzy.add(gA.key);
        consumedIntoFuzzy.add(fuzzyPartner.key);

        const clusterId = `fuzzy:${[gA.key, fuzzyPartner.key].sort().join('__')}`;
        const preferred =
          gA.mbArtistId && !fuzzyPartner.mbArtistId
            ? gA
            : fuzzyPartner.mbArtistId && !gA.mbArtistId
              ? fuzzyPartner
              : gA.trackIds.length >= fuzzyPartner.trackIds.length
                ? gA
                : fuzzyPartner;

        const status: ArtistClusterStatus = overrides.decisions[clusterId] ?? 'needs_review';
        const canonicalName = overrides.renamedCanonical[clusterId] ?? preferred.canonicalName;

        const mergedVariants = Array.from(
          new Set([
            ...Array.from(gA.variants),
            ...Array.from(fuzzyPartner.variants),
            gA.canonicalName,
            fuzzyPartner.canonicalName,
          ])
        );

        clusters.push({
          id: clusterId,
          canonicalName,
          mbArtistId: preferred.mbArtistId,
          variants: mergedVariants,
          rule: 'fuzzy_suggestion',
          similarityScore: bestSim,
          status,
          trackIds: [...gA.trackIds, ...fuzzyPartner.trackIds],
          explanation: `Ähnlichkeit ${Math.round(bestSim * 100)} % ohne identische MBID — wird niemals automatisch zusammengeführt.`,
        });
        continue;
      }
    }

    const clusterId = `cluster:${gA.key}`;
    const canonicalName = overrides.renamedCanonical[clusterId] ?? gA.canonicalName;
    const variantList = Array.from(gA.variants);

    // Only surface single-variant non-special clusters if relevant, OR include all for completeness
    const hasMultipleVariants = variantList.length > 1;
    let explanation = 'Eindeutiger kanonischer Album-Künstler (ALBUMARTIST).';
    if (gA.rule === 'compilation_va') {
      explanation = 'Compilation erkannt (COMPILATION=1) — gebündelt unter Various Artists/{Album}.';
    } else if (gA.rule === 'protected_band') {
      explanation =
        'MBID-geschützter Bandname mit "&", "," oder "vs." — wird niemals aufgesplittet.';
    } else if (hasMultipleVariants && gA.mbArtistId) {
      explanation =
        'Automatisch über identische MusicBrainz Artist-ID (MBID) / Normalisierung zusammengeführt.';
    } else if (hasMultipleVariants) {
      explanation =
        'Automatisch über exakte Normalisierung (Groß-/Kleinschreibung, Diakritika, Unicode) zusammengeführt.';
    }

    clusters.push({
      id: clusterId,
      canonicalName,
      mbArtistId: gA.mbArtistId,
      variants: variantList,
      rule: gA.rule,
      similarityScore: 1,
      status: overrides.decisions[clusterId] ?? 'auto_resolved',
      trackIds: gA.trackIds,
      explanation,
    });
  }

  const trackById = new Map<string, AudioTrack>();
  for (const t of tracks) {
    trackById.set(t.id, t);
  }

  const trackCanonicalArtist = new Map<string, string>();
  const trackHasOpenConflict = new Map<string, boolean>();

  for (const cluster of clusters) {
    for (const trackId of cluster.trackIds) {
      const track = trackById.get(trackId);
      if (cluster.status === 'split_kept' && track) {
        const extracted = extractCanonicalAlbumArtist(
          track.albumArtist || track.originalTags?.albumArtist || track.artist || '',
          track.mbArtistId,
          track.compilationFlag
        );
        trackCanonicalArtist.set(trackId, extracted.canonical);
        trackHasOpenConflict.set(trackId, false);
      } else {
        trackCanonicalArtist.set(trackId, cluster.canonicalName);
        trackHasOpenConflict.set(trackId, cluster.status === 'needs_review');
      }
    }
  }

  return { clusters, trackCanonicalArtist, trackHasOpenConflict };
}
