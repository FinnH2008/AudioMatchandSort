import JSZip from 'jszip';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { generateDockerBundle } from '../engine/dockerGenerator';
import { PipelineConfig } from '../types/tonarchiv';

interface DockerExportViewProps {
  config: PipelineConfig;
}

export function DockerExportView({ config }: DockerExportViewProps) {
  const [repoSlug, setRepoSlug] = useState<string>('dein-github-user/tonarchiv');
  const imageRef = useMemo(() => {
    const cleaned = repoSlug
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/^ghcr\.io\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    if (!cleaned) return 'ghcr.io/dein-github-user/tonarchiv:latest';
    return cleaned.includes(':') ? `ghcr.io/${cleaned}` : `ghcr.io/${cleaned}:latest`;
  }, [repoSlug]);

  const files = useMemo(() => generateDockerBundle(config, imageRef), [config, imageRef]);
  const [activeFilename, setActiveFilename] = useState<string>('docker-compose.yml');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const activeFile = files.find((f) => f.filename === activeFilename) ?? files[0];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedFile(activeFile.filename);
      window.setTimeout(() => setCopiedFile(null), 1800);
    } catch {
      setCopiedFile(null);
    }
  };

  const handleDownloadZip = async () => {
    setDownloadingZip(true);
    try {
      const zip = new JSZip();
      for (const file of files) {
        zip.file(file.filename, file.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tonarchiv-docker-bundle.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Plug-and-Play Docker-Image (einfach pullen &amp; ENV eintragen)
            </h2>
            <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
              GitHub Actions baut das Multi-Arch-Image (<span className="font-mono">amd64/arm64</span>)
              automatisch auf <span className="font-mono">ghcr.io</span>. Auf deinem Homeserver
              oder in Portainer wird das fertige Image nur noch gepullt — kein lokales{' '}
              <span className="font-mono">npm install</span>, kein Container-Build, alle Regeln und
              API-Keys werden automatisch aus den Umgebungsvariablen geladen.
            </p>
          </div>

          <button
            type="button"
            onClick={handleDownloadZip}
            disabled={downloadingZip}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-4 w-4" />
            <span>{downloadingZip ? 'Erstelle Archiv …' : 'Docker-Paket (.zip) herunterladen'}</span>
          </button>
        </div>

        <div className="pt-3 border-t border-[#243044] flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="flex-1 min-w-0 space-y-1">
            <span className="block text-xs font-medium text-slate-300">
              Dein GitHub-Repository (für das fertige GHCR Pull-Image)
            </span>
            <input
              type="text"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
              placeholder="benutzername/tonarchiv"
              className="w-full min-h-[44px] px-3 py-2 rounded-md bg-[#0F172A] border border-[#243044] font-mono text-xs text-slate-100 focus:outline-none focus:border-sky-400"
            />
          </label>
          <div className="sm:max-w-sm rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2.5">
            <div className="text-[11px] text-slate-400">Generierte Pull-Image-URL</div>
            <div className="font-mono text-xs text-sky-300 truncate">{imageRef}</div>
          </div>
        </div>
      </div>

      {/* File Tabs + Code Viewer */}
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#243044] bg-[#111927] flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Generierte Docker-Dateien" className="flex flex-wrap gap-1">
            {files.map((file) => {
              const selected = file.filename === activeFile.filename;
              return (
                <button
                  key={file.filename}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveFilename(file.filename)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs whitespace-nowrap transition-colors ${
                    selected
                      ? 'bg-sky-400/15 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{file.filename}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#243044] bg-[#0F172A] text-xs text-slate-200 hover:border-sky-400 whitespace-nowrap"
          >
            {copiedFile === activeFile.filename ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Inhalt kopieren</span>
              </>
            )}
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[#243044] text-xs text-slate-400">
          {activeFile.description}
        </div>

        <pre className="p-5 bg-[#0F172A] text-slate-200 font-mono text-xs leading-relaxed overflow-x-auto max-h-[600px] overflow-y-auto">
          <code>{activeFile.content}</code>
        </pre>
      </div>
    </div>
  );
}
