import { useState, useMemo, useCallback, memo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VaultEntry, SidebarSelection, ModifiedFile } from '../types'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  MagnifyingGlass, Plus, Wrench, Flask, Target, ArrowsClockwise,
  Users, CalendarBlank, Tag, FileText,
} from '@phosphor-icons/react'
import type { ComponentType, SVGAttributes } from 'react'
import { getTypeColor, getTypeLightColor } from '../utils/typeColors'

const TYPE_ICON_MAP: Record<string, ComponentType<SVGAttributes<SVGSVGElement>>> = {
  Project: Wrench,
  Experiment: Flask,
  Responsibility: Target,
  Procedure: ArrowsClockwise,
  Person: Users,
  Event: CalendarBlank,
  Topic: Tag,
}

function getTypeIcon(isA: string | null): ComponentType<SVGAttributes<SVGSVGElement>> {
  return (isA && TYPE_ICON_MAP[isA]) || FileText
}

interface NoteListProps {
  entries: VaultEntry[]
  selection: SidebarSelection
  selectedNote: VaultEntry | null
  allContent: Record<string, string>
  modifiedFiles?: ModifiedFile[]
  onSelectNote: (entry: VaultEntry) => void
  onCreateNote: () => void
}

interface RelationshipGroup {
  label: string
  entries: VaultEntry[]
}

function relativeDate(ts: number | null): string {
  if (!ts) return ''
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 0) {
    const date = new Date(ts * 1000)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  const date = new Date(ts * 1000)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getDisplayDate(entry: VaultEntry): number | null {
  return entry.modifiedAt ?? entry.createdAt
}

function refsMatch(refs: string[], entry: VaultEntry): boolean {
  const stem = entry.path.replace(/^.*\/Laputa\//, '').replace(/\.md$/, '')
  return refs.some((ref) => {
    const inner = ref.replace(/^\[\[/, '').replace(/\]\]$/, '')
    return inner === stem
  })
}

function resolveRefs(refs: string[], entries: VaultEntry[]): VaultEntry[] {
  return refs
    .map((ref) => {
      const inner = ref.replace(/^\[\[/, '').replace(/\]\]$/, '')
      return entries.find((e) => {
        const stem = e.path.replace(/^.*\/Laputa\//, '').replace(/\.md$/, '')
        if (stem === inner) return true
        const fileStem = e.filename.replace(/\.md$/, '')
        if (fileStem === inner.split('/').pop()) return true
        return false
      })
    })
    .filter((e): e is VaultEntry => e !== undefined)
}

function sortByModified(a: VaultEntry, b: VaultEntry): number {
  return (getDisplayDate(b) ?? 0) - (getDisplayDate(a) ?? 0)
}

function buildRelationshipGroups(entity: VaultEntry, allEntries: VaultEntry[]): RelationshipGroup[] {
  const groups: RelationshipGroup[] = []
  const seen = new Set<string>([entity.path])

  const children = allEntries
    .filter((e) => !seen.has(e.path) && e.isA !== 'Event' && refsMatch(e.belongsTo, entity))
    .sort(sortByModified)
  if (children.length > 0) {
    groups.push({ label: 'Children', entries: children })
    children.forEach((e) => seen.add(e.path))
  }

  const events = allEntries
    .filter(
      (e) =>
        !seen.has(e.path) &&
        e.isA === 'Event' &&
        (refsMatch(e.belongsTo, entity) || refsMatch(e.relatedTo, entity))
    )
    .sort(sortByModified)
  if (events.length > 0) {
    groups.push({ label: 'Events', entries: events })
    events.forEach((e) => seen.add(e.path))
  }

  const referencedBy = allEntries
    .filter((e) => !seen.has(e.path) && e.isA !== 'Event' && refsMatch(e.relatedTo, entity))
    .sort(sortByModified)
  if (referencedBy.length > 0) {
    groups.push({ label: 'Referenced By', entries: referencedBy })
    referencedBy.forEach((e) => seen.add(e.path))
  }

  const belongsTo = resolveRefs(entity.belongsTo, allEntries).filter((e) => !seen.has(e.path))
  if (belongsTo.length > 0) {
    groups.push({ label: 'Belongs To', entries: belongsTo })
    belongsTo.forEach((e) => seen.add(e.path))
  }

  const relatedTo = resolveRefs(entity.relatedTo, allEntries).filter((e) => !seen.has(e.path))
  if (relatedTo.length > 0) {
    groups.push({ label: 'Related To', entries: relatedTo })
    relatedTo.forEach((e) => seen.add(e.path))
  }

  return groups
}

function filterEntries(entries: VaultEntry[], selection: SidebarSelection, _modifiedFiles?: ModifiedFile[]): VaultEntry[] {
  switch (selection.kind) {
    case 'filter':
      switch (selection.filter) {
        case 'all':
          return entries
        case 'favorites':
          return []
      }
      break
    case 'sectionGroup':
      return entries.filter((e) => e.isA === selection.type)
    case 'entity':
      return []
    case 'topic': {
      const topic = selection.entry
      return entries.filter((e) => refsMatch(e.relatedTo, topic))
    }
  }
}

function NoteListInner({ entries, selection, selectedNote, modifiedFiles, onSelectNote, onCreateNote }: NoteListProps) {
  const [search, setSearch] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)

  const isEntityView = selection.kind === 'entity'

  const entityGroups = useMemo(
    () => isEntityView ? buildRelationshipGroups(selection.entry, entries) : [],
    [isEntityView, selection, entries]
  )

  const filtered = useMemo(
    () => isEntityView ? [] : filterEntries(entries, selection, modifiedFiles),
    [entries, selection, modifiedFiles, isEntityView]
  )

  const sorted = useMemo(
    () => isEntityView ? [] : [...filtered].sort(sortByModified),
    [filtered, isEntityView]
  )

  const query = search.trim().toLowerCase()

  const searched = useMemo(
    () => query ? sorted.filter((e) => e.title.toLowerCase().includes(query)) : sorted,
    [sorted, query]
  )

  const searchedGroups = useMemo(
    () => query
      ? entityGroups
          .map((g) => ({
            ...g,
            entries: g.entries.filter((e) => e.title.toLowerCase().includes(query)),
          }))
          .filter((g) => g.entries.length > 0)
      : entityGroups,
    [entityGroups, query]
  )


  const renderItem = useCallback((entry: VaultEntry, isPinned = false) => {
    const isSelected = selectedNote?.path === entry.path && !isPinned
    const typeColor = getTypeColor(entry.isA)
    const typeLightColor = getTypeLightColor(entry.isA)
    const TypeIcon = getTypeIcon(entry.isA)
    return (
      <div
        key={entry.path}
        className={cn(
          "relative cursor-pointer border-b border-[var(--border)] transition-colors",
          isPinned && "border-l-[3px] border-l-[var(--accent-green)] bg-muted",
          isSelected && "border-l-[3px]",
          !isPinned && !isSelected && "hover:bg-muted"
        )}
        style={{
          padding: isPinned || isSelected ? '10px 16px 10px 13px' : '10px 16px',
          ...(isSelected && {
            borderLeftColor: typeColor,
            backgroundColor: typeLightColor,
          }),
        }}
        onClick={() => onSelectNote(entry)}
      >
        <TypeIcon
          width={14}
          height={14}
          className="absolute right-3 top-2.5"
          style={{ color: typeColor }}
          data-testid="type-icon"
        />
        <div className="flex items-baseline justify-between gap-2 pr-5">
          <div className={cn(
            "min-w-0 flex-1 truncate text-[13px] text-foreground",
            isSelected ? "font-semibold" : "font-medium"
          )}>
            <span className="truncate">{entry.title}</span>
          </div>
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {relativeDate(getDisplayDate(entry))}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-muted-foreground" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {entry.snippet}
        </div>
      </div>
    )
  }, [selectedNote?.path, onSelectNote])

  return (
    <div className="flex flex-col overflow-hidden border-r border-border bg-card text-foreground" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3.5" data-tauri-drag-region style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h3 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">
          {isEntityView ? selection.entry.title : 'Notes'}
        </h3>
        <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            className="flex items-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => { setSearchVisible(!searchVisible); if (searchVisible) setSearch('') }}
            title="Search notes"
          >
            <MagnifyingGlass size={16} />
          </button>
          <button
            className="flex items-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={onCreateNote}
            title="Create new note"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* Search (toggle on icon click) */}
      {searchVisible && (
        <div className="border-b border-border px-3 py-2">
          <Input
            placeholder="Search notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-[13px]"
            autoFocus
          />
        </div>
      )}

      {/* Items */}
      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        {isEntityView ? (
          <div className="h-full overflow-y-auto">
            {renderItem(selection.entry, true)}
            {searchedGroups.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                {query ? 'No matching items' : 'No related items'}
              </div>
            ) : (
              searchedGroups.map((group) => (
                <div key={group.label} className="border-t border-[var(--border-subtle)]">
                  <div className="flex items-center justify-between px-4 py-2.5 pt-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </span>
                    <span className="rounded-full bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">{group.entries.length}</span>
                  </div>
                  {group.entries.map((entry) => renderItem(entry))}
                </div>
              ))
            )}
          </div>
        ) : (
          searched.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">No notes found</div>
          ) : (
            <Virtuoso
              style={{ height: '100%' }}
              totalCount={searched.length}
              initialItemCount={Math.min(searched.length, 30)}
              itemContent={(index) => {
                const entry = searched[index]
                return entry ? renderItem(entry) : null
              }}
            />
          )
        )}
      </div>
    </div>
  )
}

export const NoteList = memo(NoteListInner)
