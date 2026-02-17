import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import { createReactInlineContentSpec, useCreateBlockNote, SuggestionMenuController } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import type { VaultEntry, GitCommit } from '../types'
import { Inspector, type FrontmatterValue } from './Inspector'
import { DiffView } from './DiffView'
import { ResizeHandle } from './ResizeHandle'
import { useEditorTheme } from '../hooks/useTheme'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import {
  Plus,
  Columns,
  ArrowsOutSimple,
  MagnifyingGlass,
  GitBranch,
  CursorText,
  Sparkle,
  DotsThree,
} from '@phosphor-icons/react'
import { splitFrontmatter, preProcessWikilinks, injectWikilinks, countWords } from '../utils/wikilinks'
import './Editor.css'
import './EditorTheme.css'

interface Tab {
  entry: VaultEntry
  content: string
}

interface EditorProps {
  tabs: Tab[]
  activeTabPath: string | null
  entries: VaultEntry[]
  onSwitchTab: (path: string) => void
  onCloseTab: (path: string) => void
  onNavigateWikilink: (target: string) => void
  onLoadDiff?: (path: string) => Promise<string>
  isModified?: (path: string) => boolean
  onCreateNote?: () => void
  // Inspector props
  inspectorCollapsed: boolean
  onToggleInspector: () => void
  inspectorWidth: number
  onInspectorResize: (delta: number) => void
  inspectorEntry: VaultEntry | null
  inspectorContent: string | null
  allContent: Record<string, string>
  gitHistory: GitCommit[]
  onUpdateFrontmatter?: (path: string, key: string, value: FrontmatterValue) => Promise<void>
  onDeleteProperty?: (path: string, key: string) => Promise<void>
  onAddProperty?: (path: string, key: string, value: FrontmatterValue) => Promise<void>
}

// --- Custom Inline Content: WikiLink ---

const WikiLink = createReactInlineContentSpec(
  {
    type: "wikilink" as const,
    propSchema: {
      target: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => (
      <span
        className="wikilink"
        data-target={props.inlineContent.props.target}
      >
        {props.inlineContent.props.target}
      </span>
    ),
  }
)

// --- Schema with wikilink ---

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikiLink,
  },
})

/** Single BlockNote editor view — content is swapped via replaceBlocks */
function SingleEditorView({ editor, entries, onNavigateWikilink }: { editor: ReturnType<typeof useCreateBlockNote>; entries: VaultEntry[]; onNavigateWikilink: (target: string) => void }) {
  const navigateRef = useRef(onNavigateWikilink)
  navigateRef.current = onNavigateWikilink
  const { cssVars } = useEditorTheme()

  useEffect(() => {
    const container = document.querySelector('.editor__blocknote-container')
    if (!container) return
    const handler = (e: MouseEvent) => {
      const wikilink = (e.target as HTMLElement).closest('.wikilink')
      if (wikilink) {
        e.preventDefault()
        e.stopPropagation()
        const target = (wikilink as HTMLElement).dataset.target
        if (target) navigateRef.current(target)
      }
    }
    container.addEventListener('click', handler as EventListener, true)
    return () => container.removeEventListener('click', handler as EventListener, true)
  }, [editor])

  const baseItems = useMemo(
    () => entries.map(entry => ({
      title: entry.title,
      aliases: [entry.filename.replace(/\.md$/, ''), ...entry.aliases],
      group: entry.isA || 'Note',
      entryTitle: entry.title,
    })),
    [entries]
  )

  const getWikilinkItems = useCallback(async (query: string) => {
    const items = baseItems.map(item => ({
      ...item,
      onItemClick: () => {
        editor.insertInlineContent([
          {
            type: 'wikilink' as const,
            props: { target: item.entryTitle },
          },
          " ",
        ])
      },
    }))
    return filterSuggestionItems(items, query)
  }, [baseItems, editor])

  return (
    <div className="editor__blocknote-container" style={cssVars as React.CSSProperties}>
      <BlockNoteView
        editor={editor}
        theme="light"
      >
        <SuggestionMenuController
          triggerCharacter="[["
          getItems={getWikilinkItems}
        />
      </BlockNoteView>
    </div>
  )
}

export const Editor = memo(function Editor({
  tabs, activeTabPath, entries, onSwitchTab, onCloseTab, onNavigateWikilink, onLoadDiff, isModified, onCreateNote,
  inspectorCollapsed, onToggleInspector, inspectorWidth, onInspectorResize,
  inspectorEntry, inspectorContent, allContent, gitHistory,
  onUpdateFrontmatter, onDeleteProperty, onAddProperty,
}: EditorProps) {
  const [diffMode, setDiffMode] = useState(false)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // Single editor instance — reused across all tabs
  const editor = useCreateBlockNote({ schema })
  // Cache parsed blocks per tab path for instant switching
  const tabCacheRef = useRef<Map<string, any[]>>(new Map())
  const prevActivePathRef = useRef<string | null>(null)

  // Swap document content when active tab changes
  useEffect(() => {
    const cache = tabCacheRef.current
    const prevPath = prevActivePathRef.current

    // Save current editor state for the tab we're leaving
    if (prevPath && prevPath !== activeTabPath) {
      cache.set(prevPath, editor.document)
    }
    prevActivePathRef.current = activeTabPath

    if (!activeTabPath) return

    const tab = tabs.find(t => t.entry.path === activeTabPath)
    if (!tab) return

    try {
      if (cache.has(activeTabPath)) {
        // Instant switch — use cached blocks
        editor.replaceBlocks(editor.document, cache.get(activeTabPath)!)
      } else {
        // First open — parse markdown
        const [, body] = splitFrontmatter(tab.content)
        const preprocessed = preProcessWikilinks(body)
        editor.tryParseMarkdownToBlocks(preprocessed).then(blocks => {
          const withWikilinks = injectWikilinks(blocks)
          try {
            editor.replaceBlocks(editor.document, withWikilinks)
          } catch (err) {
            console.error('Failed to replace blocks:', err)
            return
          }
          cache.set(activeTabPath, withWikilinks)
        })
      }
    } catch (err) {
      console.error('Failed to swap editor content:', err)
    }
  }, [activeTabPath, tabs, editor])

  // Clean up cache entries when tabs are closed
  const tabPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const currentPaths = new Set(tabs.map(t => t.entry.path))
    for (const path of tabPathsRef.current) {
      if (!currentPaths.has(path)) {
        tabCacheRef.current.delete(path)
      }
    }
    tabPathsRef.current = currentPaths
  }, [tabs])

  const activeTab = tabs.find((t) => t.entry.path === activeTabPath) ?? null
  const isLoadingNewTab = activeTabPath !== null && !activeTab
  const showDiffToggle = activeTab && isModified?.(activeTab.entry.path)

  useEffect(() => {
    setDiffMode(false)
    setDiffContent(null)
  }, [activeTabPath])

  const handleToggleDiff = useCallback(async () => {
    if (diffMode) {
      setDiffMode(false)
      setDiffContent(null)
      return
    }
    if (!activeTabPath || !onLoadDiff) return
    setDiffLoading(true)
    try {
      const diff = await onLoadDiff(activeTabPath)
      setDiffContent(diff)
      setDiffMode(true)
    } catch (err) {
      console.warn('Failed to load diff:', err)
    } finally {
      setDiffLoading(false)
    }
  }, [diffMode, activeTabPath, onLoadDiff])

  const activeModified = activeTab ? isModified?.(activeTab.entry.path) ?? false : false
  const wordCount = activeTab ? countWords(activeTab.content) : 0

  const disabledIconStyle = { opacity: 0.4, cursor: 'not-allowed' } as const

  const tabBar = (
    <div
      className="flex shrink-0 items-stretch"
      style={{ height: 45, background: 'var(--sidebar)', WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-tauri-drag-region
    >
      {/* Tabs */}
      {tabs.map((tab) => {
        const isActive = tab.entry.path === activeTabPath
        return (
          <div
            key={tab.entry.path}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap max-w-[180px] transition-all",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-secondary-foreground"
            )}
            style={{
              background: isActive ? 'var(--background)' : 'transparent',
              borderRight: `1px solid ${isActive ? 'var(--border)' : 'var(--sidebar-border)'}`,
              borderBottom: isActive ? 'none' : '1px solid var(--sidebar-border)',
              padding: '0 12px',
              fontSize: 12,
              fontWeight: isActive ? 500 : 400,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
            onClick={() => onSwitchTab(tab.entry.path)}
          >
            <span className="truncate">{tab.entry.title}</span>
            <button
              className={cn(
                "shrink-0 rounded-sm p-0 bg-transparent border-none text-muted-foreground cursor-pointer transition-opacity hover:bg-accent hover:text-foreground",
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              style={{ lineHeight: 0 }}
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.entry.path)
              }}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}

      {/* Spacer fills remaining width */}
      <div className="flex-1" style={{ borderBottom: '1px solid var(--border)' }} />

      {/* Right controls area */}
      <div
        className="flex shrink-0 items-center"
        style={{
          borderLeft: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          gap: 12,
          padding: '0 12px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
          onClick={onCreateNote}
          title="New note"
        >
          <Plus size={16} />
        </button>
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
          style={disabledIconStyle}
          title="Coming soon"
          tabIndex={-1}
        >
          <Columns size={16} />
        </button>
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
          style={disabledIconStyle}
          title="Coming soon"
          tabIndex={-1}
        >
          <ArrowsOutSimple size={16} />
        </button>
      </div>
    </div>
  )

  const breadcrumbBar = activeTab ? (
    <div
      className="flex shrink-0 items-center justify-between"
      style={{
        height: 45,
        background: 'var(--background)',
        borderBottom: '1px solid var(--border)',
        padding: '6px 16px',
      }}
    >
      {/* Left: breadcrumb */}
      <div className="flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">{activeTab.entry.isA || 'Note'}</span>
        <span className="text-muted-foreground" style={{ margin: '0 2px' }}>&rsaquo;</span>
        <span className="font-medium text-foreground">{activeTab.entry.title}</span>
        <span className="text-muted-foreground" style={{ margin: '0 4px' }}>&middot;</span>
        <span className="text-muted-foreground">{wordCount.toLocaleString()} words</span>
        {activeModified && (
          <>
            <span className="text-muted-foreground" style={{ margin: '0 4px' }}>&middot;</span>
            <span className="font-semibold" style={{ color: 'var(--accent-yellow)' }}>M</span>
          </>
        )}
      </div>

      {/* Right: action icons */}
      <div className="flex items-center" style={{ gap: 12 }}>
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
          title="Search in file"
        >
          <MagnifyingGlass size={16} />
        </button>
        {showDiffToggle && (
          <button
            className={cn(
              "flex items-center justify-center border-none bg-transparent p-0 cursor-pointer transition-colors",
              diffMode ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={handleToggleDiff}
            disabled={diffLoading}
            title={diffLoading ? 'Loading diff...' : diffMode ? 'Back to editor' : 'Show diff'}
          >
            <GitBranch size={16} />
          </button>
        )}
        {!showDiffToggle && (
          <button
            className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
            style={disabledIconStyle}
            title="No changes"
            tabIndex={-1}
          >
            <GitBranch size={16} />
          </button>
        )}
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
          style={disabledIconStyle}
          title="Coming soon"
          tabIndex={-1}
        >
          <CursorText size={16} />
        </button>
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
          style={disabledIconStyle}
          title="Coming soon"
          tabIndex={-1}
        >
          <Sparkle size={16} />
        </button>
        <button
          className="flex items-center justify-center border-none bg-transparent p-0 text-muted-foreground"
          style={disabledIconStyle}
          title="Coming soon"
          tabIndex={-1}
        >
          <DotsThree size={16} />
        </button>
      </div>
    </div>
  ) : null

  const inspectorPanel = (
    <div
      className="shrink-0 flex flex-col min-h-0"
      style={{ width: inspectorCollapsed ? 40 : inspectorWidth, height: '100%' }}
    >
      <Inspector
        collapsed={inspectorCollapsed}
        onToggle={onToggleInspector}
        entry={inspectorEntry}
        content={inspectorContent}
        entries={entries}
        allContent={allContent}
        gitHistory={gitHistory}
        onNavigate={onNavigateWikilink}
        onUpdateFrontmatter={onUpdateFrontmatter}
        onDeleteProperty={onDeleteProperty}
        onAddProperty={onAddProperty}
      />
    </div>
  )

  if (tabs.length === 0) {
    return (
      <div className="editor flex flex-col min-h-0 overflow-hidden bg-background text-foreground">
        {tabBar}
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <p className="m-0 text-[15px]">Select a note to start editing</p>
            <span className="text-xs text-muted-foreground">Cmd+P to search &middot; Cmd+N to create</span>
          </div>
          {!inspectorCollapsed && <ResizeHandle onResize={onInspectorResize} />}
          {inspectorPanel}
        </div>
      </div>
    )
  }

  return (
    <div className="editor flex flex-col min-h-0 overflow-hidden bg-background text-foreground">
      {tabBar}
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {breadcrumbBar}
          {diffMode && (
            <div className="flex-1 overflow-auto">
              <DiffView diff={diffContent ?? ''} />
            </div>
          )}
          {!diffMode && activeTab && (
            <div
              style={{
                display: 'flex',
                flex: 1,
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <SingleEditorView
                editor={editor}
                entries={entries}
                onNavigateWikilink={onNavigateWikilink}
              />
            </div>
          )}
          {isLoadingNewTab && !diffMode && (
            <div className="flex flex-1 flex-col gap-3 p-8 animate-pulse" style={{ minHeight: 0 }}>
              <div className="h-6 w-2/5 rounded bg-muted" />
              <div className="h-4 w-4/5 rounded bg-muted" />
              <div className="h-4 w-3/5 rounded bg-muted" />
              <div className="h-4 w-4/5 rounded bg-muted" />
              <div className="h-4 w-2/5 rounded bg-muted" />
            </div>
          )}
        </div>
        {!inspectorCollapsed && <ResizeHandle onResize={onInspectorResize} />}
        {inspectorPanel}
      </div>
    </div>
  )
})
