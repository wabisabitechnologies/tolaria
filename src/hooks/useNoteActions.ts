import { useCallback, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke, addMockEntry, updateMockContent } from '../mock-tauri'
import type { VaultEntry } from '../types'
import type { FrontmatterValue } from '../components/Inspector'
import type { NoteType } from '../components/CreateNoteDialog'

interface Tab {
  entry: VaultEntry
  content: string
}

// Mock frontmatter helpers for browser testing
function updateMockFrontmatter(path: string, key: string, value: FrontmatterValue): string {
  const content = window.__mockContent?.[path] || ''
  const yamlKey = key.includes(' ') ? `"${key}"` : key

  let yamlValue: string
  if (Array.isArray(value)) {
    yamlValue = '\n' + value.map(v => `  - "${v}"`).join('\n')
  } else if (typeof value === 'boolean') {
    yamlValue = value ? 'true' : 'false'
  } else if (value === null) {
    yamlValue = 'null'
  } else {
    yamlValue = String(value)
  }

  if (!content.startsWith('---\n')) {
    return `---\n${yamlKey}: ${yamlValue}\n---\n${content}`
  }

  const fmEnd = content.indexOf('\n---', 4)
  if (fmEnd === -1) return content

  const fm = content.slice(4, fmEnd)
  const rest = content.slice(fmEnd + 4)
  const keyPattern = new RegExp(`^["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`, 'm')

  if (keyPattern.test(fm)) {
    const lines = fm.split('\n')
    const newLines: string[] = []
    let i = 0
    while (i < lines.length) {
      if (keyPattern.test(lines[i])) {
        i++
        while (i < lines.length && lines[i].startsWith('  - ')) i++
        if (Array.isArray(value)) {
          newLines.push(`${yamlKey}:${yamlValue}`)
        } else {
          newLines.push(`${yamlKey}: ${yamlValue}`)
        }
        continue
      }
      newLines.push(lines[i])
      i++
    }
    return `---\n${newLines.join('\n')}\n---${rest}`
  } else {
    if (Array.isArray(value)) {
      return `---\n${fm}\n${yamlKey}:${yamlValue}\n---${rest}`
    } else {
      return `---\n${fm}\n${yamlKey}: ${yamlValue}\n---${rest}`
    }
  }
}

function deleteMockFrontmatterProperty(path: string, key: string): string {
  const content = window.__mockContent?.[path] || ''
  if (!content.startsWith('---\n')) return content
  const fmEnd = content.indexOf('\n---', 4)
  if (fmEnd === -1) return content

  const fm = content.slice(4, fmEnd)
  const rest = content.slice(fmEnd + 4)
  const keyPattern = new RegExp(`^["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`, 'm')

  const lines = fm.split('\n')
  const newLines: string[] = []
  let i = 0
  while (i < lines.length) {
    if (keyPattern.test(lines[i])) {
      i++
      while (i < lines.length && lines[i].startsWith('  - ')) i++
      continue
    }
    newLines.push(lines[i])
    i++
  }
  return `---\n${newLines.join('\n')}\n---${rest}`
}

export function useNoteActions(
  addEntry: (entry: VaultEntry, content: string) => void,
  updateContent: (path: string, content: string) => void,
  entries: VaultEntry[],
  setToastMessage: (msg: string | null) => void,
) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  const activeTabPathRef = useRef(activeTabPath)
  activeTabPathRef.current = activeTabPath
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const handleCloseTabRef = useRef<(path: string) => void>(() => {})

  const handleSelectNote = useCallback(async (entry: VaultEntry) => {
    // If already open, just switch — instant
    if (tabsRef.current.some((t) => t.entry.path === entry.path)) {
      setActiveTabPath(entry.path)
      return
    }

    // Load content async, then add tab and set active together
    try {
      const content = isTauri()
        ? await invoke<string>('get_note_content', { path: entry.path })
        : await mockInvoke<string>('get_note_content', { path: entry.path })
      setTabs((prev) => {
        if (prev.some((t) => t.entry.path === entry.path)) return prev
        return [...prev, { entry, content }]
      })
      setActiveTabPath(entry.path)
    } catch (err) {
      console.warn('Failed to load note content:', err)
      setTabs((prev) => {
        if (prev.some((t) => t.entry.path === entry.path)) return prev
        return [...prev, { entry, content: '' }]
      })
      setActiveTabPath(entry.path)
    }
  }, [])

  const handleCloseTab = useCallback((path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.entry.path !== path)
      if (path === activeTabPathRef.current && next.length > 0) {
        const closedIdx = prev.findIndex((t) => t.entry.path === path)
        const newIdx = Math.min(closedIdx, next.length - 1)
        setActiveTabPath(next[newIdx].entry.path)
      } else if (next.length === 0) {
        setActiveTabPath(null)
      }
      return next
    })
  }, [])
  handleCloseTabRef.current = handleCloseTab

  const handleSwitchTab = useCallback((path: string) => {
    setActiveTabPath(path)
  }, [])

  const handleNavigateWikilink = useCallback((target: string) => {
    const targetLower = target.toLowerCase()
    const slugToWords = (s: string) => s.replace(/-/g, ' ').toLowerCase()
    const targetAsWords = slugToWords(target.split('/').pop() ?? target)

    const found = entries.find((e) => {
      if (e.title.toLowerCase() === targetLower) return true
      if (e.aliases.some((a) => a.toLowerCase() === targetLower)) return true
      const pathStem = e.path.replace(/^.*\/Laputa\//, '').replace(/\.md$/, '')
      if (pathStem.toLowerCase() === targetLower) return true
      const fileStem = e.filename.replace(/\.md$/, '')
      if (fileStem.toLowerCase() === targetLower.split('/').pop()) return true
      if (e.title.toLowerCase() === targetAsWords) return true
      return false
    })

    if (found) {
      handleSelectNote(found)
    } else {
      console.warn(`Navigation target not found: ${target}`)
    }
  }, [entries, handleSelectNote])

  const handleCreateNote = useCallback(async (title: string, type: NoteType) => {
    const typeToFolder: Record<string, string> = {
      Note: 'note', Project: 'project', Experiment: 'experiment',
      Responsibility: 'responsibility', Procedure: 'procedure',
      Person: 'person', Event: 'event', Topic: 'topic',
    }
    const folder = typeToFolder[type] || 'note'
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    const path = `/Users/luca/Laputa/${folder}/${slug}.md`
    const now = Math.floor(Date.now() / 1000)

    const newEntry: VaultEntry = {
      path, filename: `${slug}.md`, title, isA: type,
      aliases: [], belongsTo: [], relatedTo: [],
      status: type === 'Topic' || type === 'Person' ? null : 'Active',
      owner: null, cadence: null, modifiedAt: now, createdAt: now, fileSize: 0,
    }

    const frontmatter = [
      '---', `title: ${title}`, `is_a: ${type}`,
      ...(newEntry.status ? [`status: ${newEntry.status}`] : []),
      '---',
    ].join('\n')
    const content = `${frontmatter}\n\n# ${title}\n\n`

    if (!isTauri()) {
      addMockEntry(newEntry, content)
    }

    addEntry(newEntry, content)
    handleSelectNote(newEntry)
  }, [handleSelectNote, addEntry])

  const handleUpdateFrontmatter = useCallback(async (path: string, key: string, value: FrontmatterValue) => {
    try {
      let newContent: string
      if (isTauri()) {
        let rustValue: unknown = value
        if (Array.isArray(value)) rustValue = value
        else if (typeof value === 'boolean') rustValue = value
        else if (typeof value === 'number') rustValue = value
        else if (value === null) rustValue = null
        else rustValue = String(value)
        newContent = await invoke<string>('update_frontmatter', { path, key, value: rustValue })
      } else {
        newContent = updateMockFrontmatter(path, key, value)
        updateMockContent(path, newContent)
      }
      setTabs((prev) => prev.map((t) =>
        t.entry.path === path ? { ...t, content: newContent } : t
      ))
      updateContent(path, newContent)
      setToastMessage('Property updated')
    } catch (err) {
      console.error('Failed to update frontmatter:', err)
      setToastMessage('Failed to update property')
    }
  }, [updateContent, setToastMessage])

  const handleDeleteProperty = useCallback(async (path: string, key: string) => {
    try {
      let newContent: string
      if (isTauri()) {
        newContent = await invoke<string>('delete_frontmatter_property', { path, key })
      } else {
        newContent = deleteMockFrontmatterProperty(path, key)
        updateMockContent(path, newContent)
      }
      setTabs((prev) => prev.map((t) =>
        t.entry.path === path ? { ...t, content: newContent } : t
      ))
      updateContent(path, newContent)
      setToastMessage('Property deleted')
    } catch (err) {
      console.error('Failed to delete property:', err)
      setToastMessage('Failed to delete property')
    }
  }, [updateContent, setToastMessage])

  const handleAddProperty = useCallback(async (path: string, key: string, value: FrontmatterValue) => {
    return handleUpdateFrontmatter(path, key, value)
  }, [handleUpdateFrontmatter])

  const closeAllTabs = useCallback(() => {
    setTabs([])
    setActiveTabPath(null)
  }, [])

  return {
    tabs,
    activeTabPath,
    activeTabPathRef,
    handleCloseTabRef,
    handleSelectNote,
    handleCloseTab,
    handleSwitchTab,
    handleNavigateWikilink,
    handleCreateNote,
    handleUpdateFrontmatter,
    handleDeleteProperty,
    handleAddProperty,
    closeAllTabs,
  }
}
