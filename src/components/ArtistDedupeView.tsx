import { AlertTriangle, Check, Disc3, Shield } from 'lucide-react';
import { useState } from 'react';
import { ArtistCluster, ArtistClusterStatus } from '../types/tonarchiv';

interface ArtistDedupeViewProps {
  clusters: ArtistCluster[];
  onSetClusterDecision: (clusterId: string, status: ArtistClusterStatus) => void;
  onRenameCluster: (clusterId: string, newCanonicalName: string) => void;
  onResolveAllFuzzy: () => void;
}

export function ArtistDedupeView({
  clusters,
  onSetClusterDecision,
  onRenameCluster,
  onResolveAllFuzzy,
}: ArtistDedupeViewProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [visibleFuzzy, setVisibleFuzzy] = useState(50);
  const [visibleAutoMerged, setVisibleAutoMerged] = useState(50);

  const fuzzyClusters = clusters.filter((c) => c.rule === 'fuzzy_suggestion');
  const openFuzzyCount = fuzzyClusters.filter((c) => c.status === 'needs_review').length;
  const protectedBands = clusters.filter((c) => c.rule === 'protected_band');
  const compilations = clusters.filter((c) => c.rule === 'compilation_va');
  const autoMerged = clusters.filter(
    (c) =>
      (c.rule === 'mbid_exact' || c.rule === 'exact_normalization') &&
      c.variants.length > 1
  );

  const startEdit = (cluster: ArtistCluster) => {
    setEditingId(cluster.id);
    setDraftName(cluster.canonicalName);
  };

  const commitEdit = (clusterId: string) => {
    if (draftName.trim()) {
      onRenameCluster(clusterId, draftName.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="space-y-8">
      {/* Header Summary */}
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Entschärfte Künstler-Deduplizierung (Ordnername strikt aus ALBUMARTIST)
          </h2>
          <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
            Automatische Zusammenführung erfolgt ausschließlich bei identischer MusicBrainz
            Artist-ID (MBID) oder exakter Normalisierung (Groß-/Kleinschreibung, Diakritika,
            Unicode). Fuzzy-Vorschläge bleiben immer <span className="font-mono">needs_review</span>
            . Modus 2 überspringt betroffene Tracks; Modus 3 schaltet erst bei 0 offenen Konflikten
            frei.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`font-mono text-xs tabular-nums ${
              openFuzzyCount > 0 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {openFuzzyCount === 0
              ? '0 offene Konflikte (Modus 3 bereit)'
              : `${openFuzzyCount} offene Fuzzy-Vorschläge`}
          </span>
          {openFuzzyCount > 0 && (
            <button
              type="button"
              onClick={onResolveAllFuzzy}
              className="px-3.5 py-2 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap"
            >
              Alle Vorschläge bestätigen
            </button>
          )}
        </div>
      </div>

      {/* 1. Fuzzy Suggestions (needs_review — NEVER auto-merged) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <h3 className="font-display text-sm font-semibold text-slate-200">
            Manuelle Prüfung erforderlich (Fuzzy-Ähnlichkeit · needs_review)
          </h3>
        </div>

        {fuzzyClusters.length === 0 ? (
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-6 text-xs text-slate-400">
            Keine Fuzzy-Künstler-Vorschläge vorhanden.
          </div>
        ) : (
          <div className="divide-y divide-[#243044] bg-[#151E2E] border border-[#243044] rounded-lg">
            {fuzzyClusters.slice(0, visibleFuzzy).map((cluster) => (
              <div
                key={cluster.id}
                className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {editingId === cluster.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit(cluster.id);
                          }}
                          aria-label="Kanonischer Künstlername"
                          className="rounded bg-[#0F172A] border border-sky-400 px-2.5 py-1 text-sm text-slate-100 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => commitEdit(cluster.id)}
                          className="px-2.5 py-1 rounded bg-sky-400 text-slate-950 text-xs font-semibold"
                        >
                          OK
                        </button>
                      </div>
                    ) : (
                      <span className="font-display text-sm font-semibold text-slate-100">
                        Ziel-Ordner: {cluster.canonicalName}
                      </span>
                    )}
                    <span className="text-slate-600">·</span>
                    <span
                      className={`font-mono text-xs ${
                        cluster.status === 'needs_review'
                          ? 'text-amber-400'
                          : cluster.status === 'user_confirmed'
                            ? 'text-emerald-400'
                            : 'text-sky-300'
                      }`}
                    >
                      {cluster.status === 'needs_review'
                        ? 'needs_review'
                        : cluster.status === 'user_confirmed'
                          ? 'Zusammengeführt (bestätigt)'
                          : 'Getrennt behalten'}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="font-mono text-xs tabular-nums text-slate-400">
                      {cluster.trackIds.length} Tracks
                    </span>
                  </div>

                  <div className="text-xs text-slate-300">
                    Gefundene Varianten:{' '}
                    <span className="font-mono text-slate-200">
                      {cluster.variants.join('  /  ')}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">{cluster.explanation}</div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onSetClusterDecision(cluster.id, 'user_confirmed')}
                    className={`min-h-[42px] sm:min-h-0 inline-flex items-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                      cluster.status === 'user_confirmed'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>Zusammenführen</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetClusterDecision(cluster.id, 'split_kept')}
                    className={`min-h-[42px] sm:min-h-0 px-3 py-2 sm:py-1.5 rounded-md text-xs font-medium border whitespace-nowrap ${
                      cluster.status === 'split_kept'
                        ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                        : 'border-[#243044] bg-[#0F172A] text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    Getrennt behalten
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(cluster)}
                    className="min-h-[42px] sm:min-h-0 px-3 py-2 sm:py-1.5 rounded-md text-xs font-medium border border-[#243044] bg-[#0F172A] text-slate-300 hover:border-slate-500 whitespace-nowrap"
                  >
                    Umbenennen
                  </button>
                </div>
              </div>
            ))}
            {fuzzyClusters.length > visibleFuzzy && (
              <div className="px-5 py-3 bg-[#111927] flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-slate-400">
                  Zeige {visibleFuzzy} von {fuzzyClusters.length} Vorschlägen
                </span>
                <button
                  type="button"
                  onClick={() => setVisibleFuzzy((n) => n + 50)}
                  className="text-sky-300 font-medium hover:text-sky-200"
                >
                  Weitere 50 anzeigen
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2. MBID-Protected Bands (&, ,, vs.) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-emerald-400" />
          <h3 className="font-display text-sm font-semibold text-slate-200">
            MBID-geschützte Bandnamen (werden nicht an „&amp;“, „,“ oder „vs.“ gesplittet)
          </h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {protectedBands.map((band) => (
            <div
              key={band.id}
              className="bg-[#151E2E] border border-[#243044] rounded-lg p-4 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-100">{band.canonicalName}</div>
                <div className="font-mono text-[11px] text-slate-500 truncate mt-0.5">
                  MBID: {band.mbArtistId}
                </div>
              </div>
              <span className="font-mono text-xs text-emerald-400 whitespace-nowrap">
                Geschützt · {band.trackIds.length} Track(s)
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 3. Compilations & Auto-Merged (Exact / MBID) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Disc3 className="h-4 w-4 text-sky-400" />
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Compilations (Various Artists)
            </h3>
          </div>
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg divide-y divide-[#243044]">
            {compilations.map((c) => (
              <div key={c.id} className="p-4 space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-100">{c.canonicalName}</span>
                  <span className="font-mono text-sky-300">COMPILATION=1</span>
                </div>
                <div className="text-slate-400">{c.explanation}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-200">
            Automatisch zusammengeführt (nur MBID &amp; exakte Normalisierung)
          </h3>
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg divide-y divide-[#243044]">
            {autoMerged.slice(0, visibleAutoMerged).map((c) => (
              <div key={c.id} className="p-4 space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-100">{c.canonicalName}</span>
                  <span className="font-mono text-emerald-400">Auto-Merge</span>
                </div>
                <div className="font-mono text-slate-300">{c.variants.join('  →  ')}</div>
                <div className="text-slate-400">{c.explanation}</div>
              </div>
            ))}
            {autoMerged.length > visibleAutoMerged && (
              <div className="px-4 py-3 bg-[#111927] flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-slate-400">
                  Zeige {visibleAutoMerged} von {autoMerged.length}
                </span>
                <button
                  type="button"
                  onClick={() => setVisibleAutoMerged((n) => n + 50)}
                  className="text-sky-300 font-medium hover:text-sky-200"
                >
                  Weitere 50 anzeigen
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
