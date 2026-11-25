import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface BackupConfirmModalProps {
  open: boolean;
  hostMusicDir: string;
  tracksToTagCount: number;
  skippedConflictCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BackupConfirmModal({
  open,
  hostMusicDir,
  tracksToTagCount,
  skippedConflictCount,
  onCancel,
  onConfirm,
}: BackupConfirmModalProps) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!open) {
      setChecked(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80"
    >
      <div className="w-full max-w-xl bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-[#243044]">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
            <h2 id="backup-modal-title" className="font-display text-lg font-semibold text-slate-100">
              Pflichthinweis vor Modus 2: Backup oder Snapshot erstellen
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Dialog schließen"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 text-sm text-slate-300 leading-relaxed">
          <p>
            Ab <strong className="text-slate-100">Modus 2 (Taggen)</strong> schreibt TonArchiv
            erstmals direkt in die Audiodateien unter{' '}
            <span className="font-mono text-slate-100">{hostMusicDir}</span>.
          </p>

          <div className="bg-[#0F172A] border border-[#243044] rounded-md p-4 space-y-2 text-xs text-slate-300">
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Tracks für Tagging vorgesehen</span>
              <span className="font-mono tabular-nums text-slate-100">{tracksToTagCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Übersprungen (offener Künstlerkonflikt)</span>
              <span className="font-mono tabular-nums text-amber-400">{skippedConflictCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Sicherheitsnetz im Container</span>
              <span className="font-mono text-emerald-400">
                rollback.json (atomar + fsync + Original-Tags)
              </span>
            </div>
          </div>

          <p className="text-slate-400 text-xs">
            Trotz atomarem Write-Ahead-Journal und gesicherter Original-Tags solltest du vor dem
            ersten Schreiblauf ein vollwertiges Backup oder einen Dateisystem-Snapshot (z. B. ZFS /
            Btrfs / Synology Snapshot) deiner Bibliothek anlegen.
          </p>

          <label className="flex items-start gap-3 pt-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
            />
            <span className="text-sm text-slate-100">
              Ich bestätige, dass ein Backup oder Snapshot der Bibliothek vorhanden ist und Modus 2
              (Taggen) gestartet werden darf.
            </span>
          </label>
        </div>

        <div className="px-6 py-4 bg-[#111927] border-t border-[#243044] flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={!checked}
            onClick={onConfirm}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold whitespace-nowrap transition-colors ${
              checked
                ? 'bg-sky-400 text-slate-950 hover:bg-sky-300 cursor-pointer'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>Backup bestätigt — Modus 2 starten</span>
          </button>
        </div>
      </div>
    </div>
  );
}
