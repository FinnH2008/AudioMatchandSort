import {
  Copy,
  Disc3,
  FolderTree,
  Menu,
  Package,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import React from 'react';

export type NavSectionId =
  | 'library'
  | 'duplicates'
  | 'artists'
  | 'rules'
  | 'pipeline'
  | 'docker';

interface SidebarProps {
  activeSection: NavSectionId;
  onSelectSection: (section: NavSectionId) => void;
  counts: {
    tracks: number;
    duplicates: number;
    openArtistConflicts: number;
    pendingReRun: number;
  };
  musicDir: string;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{
  id: NavSectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'library', label: 'Bibliothek', icon: Disc3 },
  { id: 'duplicates', label: 'Duplikate', icon: Copy },
  { id: 'artists', label: 'Künstler-Check', icon: Users },
  { id: 'rules', label: 'Ordner & Regeln', icon: FolderTree },
  { id: 'pipeline', label: 'Pipeline & Cache', icon: SlidersHorizontal },
  { id: 'docker', label: 'Docker-Export', icon: Package },
];

export function Sidebar({
  activeSection,
  onSelectSection,
  counts,
  musicDir,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const renderCount = (id: NavSectionId) => {
    if (id === 'library') {
      return (
        <span className="font-mono text-xs tabular-nums text-slate-400">
          {counts.tracks}
        </span>
      );
    }
    if (id === 'duplicates' && counts.duplicates > 0) {
      return (
        <span className="font-mono text-xs tabular-nums text-amber-400">
          {counts.duplicates}
        </span>
      );
    }
    if (id === 'artists' && counts.openArtistConflicts > 0) {
      return (
        <span className="font-mono text-xs tabular-nums text-amber-400">
          {counts.openArtistConflicts} offen
        </span>
      );
    }
    return null;
  };

  const navContent = (
    <div className="flex h-full flex-col bg-[#111927] border-r border-[#243044]">
      <div className="flex h-16 items-center justify-between px-5 border-b border-[#243044]">
        <span className="font-display text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0">
          TonArchiv
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Navigation schließen"
          className="lg:hidden rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav aria-label="Hauptnavigation" className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectSection(item.id);
                onCloseMobile();
              }}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors duration-150 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-sky-400 ${
                active
                  ? 'bg-sky-400/12 text-sky-300'
                  : 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-sky-400' : 'text-slate-400'}`} />
                <span className="truncate">{item.label}</span>
              </span>
              {renderCount(item.id)}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-[#243044] px-5 py-4 space-y-1.5 text-xs text-slate-400">
        <div className="text-slate-500">Gemounteter Ordner</div>
        <div className="font-mono text-slate-300 truncate" title={musicDir}>
          {musicDir}
        </div>
        {counts.pendingReRun > 0 && (
          <div className="pt-1 text-sky-300 font-mono tabular-nums">
            {counts.pendingReRun} Track(s) für Re-Run vorgemerkt
          </div>
        )}
      </div>
    </div>
  );

  const mobileBottomItems: Array<{
    id: NavSectionId;
    shortLabel: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeCount?: number;
  }> = [
    { id: 'library', shortLabel: 'Bibliothek', icon: Disc3, badgeCount: counts.tracks },
    { id: 'duplicates', shortLabel: 'Duplikate', icon: Copy, badgeCount: counts.duplicates },
    {
      id: 'artists',
      shortLabel: 'Künstler',
      icon: Users,
      badgeCount: counts.openArtistConflicts,
    },
    { id: 'pipeline', shortLabel: 'Pipeline', icon: SlidersHorizontal },
  ];

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/75"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[84vw] h-full z-10">{navContent}</aside>
        </div>
      )}

      {/* Mobile Fixed Bottom Thumb Navigation Bar (14px + safe-area <= 56px) */}
      <nav
        aria-label="Mobile Schnellnavigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-[#111927]/95 backdrop-blur-md border-t border-[#243044] grid grid-cols-5 items-stretch"
      >
        {mobileBottomItems.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[44px] px-1 transition-colors ${
                active ? 'text-sky-400' : 'text-slate-400 active:text-slate-100'
              }`}
            >
              <Icon className="h-4.5 w-4.5 shrink-0" />
              <span className="text-[10px] font-medium leading-none tracking-tight whitespace-nowrap">
                {item.shortLabel}
              </span>
              {typeof item.badgeCount === 'number' && item.badgeCount > 0 && (
                <span className="absolute top-1.5 right-2.5 font-mono text-[9px] tabular-nums leading-none text-amber-400">
                  {item.badgeCount}
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            onSelectSection(activeSection === 'rules' ? 'docker' : 'rules');
          }}
          aria-current={activeSection === 'rules' || activeSection === 'docker' ? 'page' : undefined}
          className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] px-1 transition-colors ${
            activeSection === 'rules' || activeSection === 'docker'
              ? 'text-sky-400'
              : 'text-slate-400 active:text-slate-100'
          }`}
        >
          {activeSection === 'rules' ? (
            <Package className="h-4.5 w-4.5 shrink-0" />
          ) : (
            <Menu className="h-4.5 w-4.5 shrink-0" />
          )}
          <span className="text-[10px] font-medium leading-none tracking-tight whitespace-nowrap">
            {activeSection === 'rules' ? 'Docker' : 'Regeln'}
          </span>
        </button>
      </nav>
    </>
  );
}
