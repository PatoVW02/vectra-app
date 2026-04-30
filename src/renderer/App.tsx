import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react'
import { Toolbar } from './components/Toolbar'
import { BottomBar } from './components/BottomBar'
import { Breadcrumb } from './components/Breadcrumb'
import { TreemapView } from './components/TreemapView'
import { ContextMenu } from './components/ContextMenu'
import { SelectionBar } from './components/SelectionBar'
import { InfoPanel } from './components/InfoPanel'
import { SmartCleanPanel } from './components/SmartCleanPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { useNavigation } from './hooks/useNavigation'
import { useTreeScanner } from './hooks/useTreeScanner'
import { isAppleMetadata, isCleanable, isDevDependency } from './utils/cleanable'
import { isCriticalPath, isContentOnlyProtectedRoot } from './utils/criticalPaths'
import { DiskEntry, PlatformInfo } from './types'
import { SettingsPanel } from './components/SettingsPanel'
import type { SettingsTab } from './components/SettingsPanel'
import { OnboardingFlow } from './components/OnboardingFlow'
import { useLicense } from './hooks/useLicense'
import { UpgradeModal } from './components/UpgradeModal'
import { LicenseModal } from './components/LicenseModal'
import { WhatsNewModal } from './components/WhatsNewModal'
import { getDefaultQuickScanFolders, getQuickScanRootPath, resolveQuickFolderPath } from '../shared/policy'
import { isAbsoluteUiPath, normalizeUiPath, pathBasename, pathParent } from './utils/path'

interface ContextMenuState {
  entry: DiskEntry
  x: number
  y: number
}

interface UpdateToastState {
  version: string
  downloaded: boolean
}

function getTreeEntries(tree: Map<string, DiskEntry[]>, targetPath: string | null): DiskEntry[] {
  if (!targetPath) return []

  const direct = tree.get(targetPath)
  if (direct) return direct

  const normalizedTarget = normalizeUiPath(targetPath)
  for (const [key, entries] of tree) {
    if (normalizeUiPath(key) === normalizedTarget) return entries
  }

  return []
}

/** Mounts children and immediately plays a slide-up-from-bottom entrance. */
function SlideUpBar({ children }: { children: ReactNode }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <div
      className="transition-transform duration-300 ease-out"
      style={{ transform: entered ? 'translateY(0)' : 'translateY(100%)' }}
    >
      {children}
    </div>
  )
}

type ScanMode = 'quick' | 'deep'
type ScanPhase = 'welcome' | 'departing' | 'active' | 'arriving'

const MIN_PANEL_WIDTH = 220
const DEFAULT_PANEL_WIDTH = 400
const PANEL_MAX_RATIO = 0.75
const MAIN_VIEW_MIN_W = 260
// Split ratio: fraction of panel height given to InfoPanel (top). 0.5 = equal.
const DEFAULT_SPLIT = 0.5
const MIN_SPLIT = 0.2
const MAX_SPLIT = 0.8
const FREE_DELETE_LIMIT_PER_MONTH = 15

function getPanelMaxWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH
  return Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth * PANEL_MAX_RATIO) - MAIN_VIEW_MIN_W)
}

export function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)

  useEffect(() => {
    window.electronAPI.getSettings().then((s) => setOnboardingDone(s.onboardingComplete))
  }, [])

  if (onboardingDone === null) return null // wait for settings to load

  if (!onboardingDone) {
    return <OnboardingFlow onComplete={() => setOnboardingDone(true)} />
  }

  return <AppShell />
}

function AppShell() {
  const MODAL_SWITCH_DELAY_MS = 200
  const [scanMode, setScanMode] = useState<ScanMode>('quick')
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [showDevDeps, setShowDevDeps] = useState(false)
  const [deleteImmediately, setDeleteImmediately] = useState(false)
  const [quickScanFolders, setQuickScanFolders] = useState<string[]>([])
  const [homeDir, setHomeDir] = useState<string | null>(null)
  const [deleteQuotaUsed, setDeleteQuotaUsed] = useState(0)

  // Derived from homeDir — the ~/Library path used as quick scan root
  const QUICK_SCAN_PATH = useMemo(
    () => {
      const value = getQuickScanRootPath(homeDir, platformInfo?.id ?? 'macos')
      return value ? normalizeUiPath(value) : null
    },
    [homeDir, platformInfo]
  )

  // Load initial settings + home dir from main process (process.env.HOME is
  // not reliably available in the Vite-built renderer bundle)
  useEffect(() => {
    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getHomeDir(),
      window.electronAPI.getPlatformInfo(),
    ]).then(([s, home, platform]) => {
      const defaults = getDefaultQuickScanFolders(platform.id)
      setShowDevDeps(s.showDevDependencies ?? false)
      setDeleteImmediately(s.deleteImmediately ?? false)
      setQuickScanFolders((s.quickScanFolders?.length ? s.quickScanFolders : defaults).map((folder) => isAbsoluteUiPath(folder) || folder.includes('\\') ? normalizeUiPath(folder) : folder))
      setDeleteQuotaUsed(s.deleteQuota?.used ?? 0)
      setHomeDir(normalizeUiPath(home))
      setPlatformInfo(platform)
    })
  }, [])
  const [selectedPath, setSelectedPath] = useState('/')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Map<string, DiskEntry>>(new Map())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [scanPhase, setScanPhase] = useState<ScanPhase>('welcome')
  const [scanTrigger, setScanTrigger] = useState(0)

  const { license, isPremium, activate, deactivate } = useLicense()
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  // Show What's New once per app version (tracked in localStorage).
  useEffect(() => {
    window.electronAPI.getAppVersion().then((version) => {
      setAppVersion(version)
      const lastSeen = localStorage.getItem('nerion:lastSeenWhatsNewVersion')
      if (lastSeen !== version) setWhatsNewOpen(true)
    }).catch(() => {})
  }, [])

  // Independent panel states — both can be open simultaneously
  const [infoPanelEntry, setInfoPanelEntry] = useState<DiskEntry | null>(null)
  const [smartCleanOpen, setSmartCleanOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmedDeletedPaths, setConfirmedDeletedPaths] = useState<Set<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRequestedTab, setSettingsRequestedTab] = useState<SettingsTab | null>(null)
  const [updateToast, setUpdateToast] = useState<UpdateToastState | null>(null)

  // Smart Clean session state — reset on every new scan
  const prevScanning = useRef(false)
  const [savedLeftoverSelection, setSavedLeftoverSelection] = useState<Set<string> | null>(null)

  // Resizable right panel
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT)

  const draggingWidth = useRef(false)
  const draggingSplit = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const rightPanelRef = useRef<HTMLDivElement>(null)

  const panelVisible = infoPanelEntry !== null || smartCleanOpen
  const bothOpen = infoPanelEntry !== null && smartCleanOpen

  const { stack, currentPath, navigate, goTo, resetTo } = useNavigation()

  // In quick mode, the allowed folder paths act as a filter for both the block
  // view and Smart Clean. Deep mode = no filter (null).
  const quickScanAllowedPaths = useMemo(() => {
    if (scanMode !== 'quick' || !QUICK_SCAN_PATH) return null
    const paths = quickScanFolders
      .map((folder) => resolveQuickFolderPath(folder, homeDir, platformInfo?.id ?? 'macos'))
      .filter((value): value is string => value !== null)
      .map((value) => normalizeUiPath(value))
    return new Set(paths)
  }, [scanMode, quickScanFolders, QUICK_SCAN_PATH, homeDir, platformInfo])

  // Paths to actually scan in Quick mode: ~/Library (when predefined Library folders are enabled)
  // plus any absolute custom paths that live outside of ~/Library.
  const quickScanPaths = useMemo(() => {
    if (scanMode !== 'quick' || !QUICK_SCAN_PATH) return null
    const paths = quickScanFolders
      .map((folder) => resolveQuickFolderPath(folder, homeDir, platformInfo?.id ?? 'macos'))
      .filter((value): value is string => value !== null)
      .map((value) => normalizeUiPath(value))
    return paths.length > 0 ? paths : null
  }, [scanMode, quickScanFolders, QUICK_SCAN_PATH, homeDir, platformInfo])

  const deepScanPaths = useMemo(() => {
    if (scanMode !== 'deep' || !rootPath || !homeDir) return null
    if ((platformInfo?.id ?? 'macos') === 'windows') return [rootPath]
    const trashPath = normalizeUiPath(`${homeDir}/.Trash`)
    const normalizedRoot = rootPath.replace(/\/+$/, '')
    if (trashPath === normalizedRoot || trashPath.startsWith(normalizedRoot + '/')) return null
    return [rootPath, trashPath]
  }, [scanMode, rootPath, homeDir, platformInfo])

  const { tree, scanning, scannedCount, removeEntries, cancelScan } = useTreeScanner(
    rootPath,
    scanTrigger,
    scanMode === 'quick' ? quickScanPaths : deepScanPaths
  )

  // Reverse transition: mount welcome in an "arriving" state, then animate to resting state.
  useEffect(() => {
    if (scanPhase !== 'arriving') return
    const id = requestAnimationFrame(() => setScanPhase('welcome'))
    return () => cancelAnimationFrame(id)
  }, [scanPhase])

  // At the root level of a quick scan only show the configured subfolders; deep
  // into the tree (or in deep mode) show everything as normal.
  const currentEntries = useMemo(() => {
    const raw = getTreeEntries(tree, currentPath)
    const filterDeleted = (entries: DiskEntry[]) =>
      confirmedDeletedPaths.size === 0 ? entries : entries.filter(e => !confirmedDeletedPaths.has(e.path))
    if (!quickScanAllowedPaths || currentPath !== rootPath) return filterDeleted(raw)
    // At the quick scan root: Library subfolder entries + home-relative entries + custom absolute entries
    const libraryEntries = raw.filter(e => quickScanAllowedPaths.has(e.path))
    const homeEntries: DiskEntry[] = quickScanFolders
      .filter(f => !isAbsoluteUiPath(f) && homeDir)
      .map(f => {
        const resolvedPath = resolveQuickFolderPath(f, homeDir, platformInfo?.id ?? 'macos')
        if (!resolvedPath) return null
        const normalizedResolvedPath = normalizeUiPath(resolvedPath)
        if (!quickScanAllowedPaths.has(normalizedResolvedPath)) return null
        const children = getTreeEntries(tree, normalizedResolvedPath)
        const totalKB = children.reduce((s, e) => s + e.sizeKB, 0)
        return { name: f, path: normalizedResolvedPath, sizeKB: totalKB, isDir: true } as DiskEntry
      })
      .filter((e): e is DiskEntry => e !== null)
    const customEntries: DiskEntry[] = quickScanFolders
      .filter((f) => {
        if (!isAbsoluteUiPath(f) || !quickScanAllowedPaths.has(f)) return false
        if (!QUICK_SCAN_PATH) return true
        return !(f === QUICK_SCAN_PATH || f.startsWith(QUICK_SCAN_PATH + '/'))
      })
      .map(f => {
        const children = getTreeEntries(tree, f)
        const totalKB = children.reduce((s, e) => s + e.sizeKB, 0)
        return { name: pathBasename(f), path: f, sizeKB: totalKB, isDir: true }
      })
    return filterDeleted([...libraryEntries, ...homeEntries, ...customEntries].sort((a, b) => b.sizeKB - a.sizeKB))
  }, [tree, currentPath, rootPath, quickScanAllowedPaths, quickScanFolders, QUICK_SCAN_PATH, homeDir, confirmedDeletedPaths, platformInfo])

  const allCleanable = useMemo(() => {
    const result = new Map<string, DiskEntry>()
    // Pre-compute prefix list once so the inner loop is cheap
    const allowedPrefixes = quickScanAllowedPaths ? [...quickScanAllowedPaths] : null

    // Downloads directories that are the explicit target of this scan (rootPath itself
    // is a Downloads folder, or a quick-scan path is a Downloads folder).
    // Their direct children are all treated as cleanable — the whole point of scanning
    // Downloads is to clean it up.
    const downloadsParents = new Set<string>()
    if (rootPath && pathBasename(rootPath).toLowerCase() === 'downloads') {
      downloadsParents.add(rootPath)
    }
    if (quickScanAllowedPaths) {
      for (const p of quickScanAllowedPaths) {
        if (pathBasename(p).toLowerCase() === 'downloads') downloadsParents.add(p)
      }
    }

    // Direct children of the user's Trash should always be considered cleanable,
    // but never the Trash folder itself.
    const trashParents = new Set<string>()
    if (homeDir && (platformInfo?.id ?? 'macos') === 'macos') {
      trashParents.add(normalizeUiPath(`${homeDir}/.Trash`))
    }

    for (const entries of tree.values()) {
      for (const entry of entries) {
        if (isAppleMetadata(entry)) continue
        if (isCriticalPath(entry.path) && !isContentOnlyProtectedRoot(entry.path)) continue
        const isDev = isDevDependency(entry)

        // Direct children of a targeted Downloads folder are always cleanable
        const parentDir = pathParent(entry.path)
        const isDownloadsItem = downloadsParents.size > 0
          && downloadsParents.has(parentDir)
          && entry.sizeKB > 0
        const isTrashItem = trashParents.has(parentDir) && entry.sizeKB > 0

        if (allowedPrefixes && !isDev && !isDownloadsItem && !isTrashItem) {
          // For regular cache/temp entries: restrict to the quick-scan allowed paths
          // (e.g. ~/Library/Caches, ~/Library/Logs, custom absolute paths).
          // Dev dependencies are intentionally exempt from this filter — they have their
          // own guards (MANAGED_PATH_SUBSTRINGS / SYSTEM_PATH_PREFIXES) and should
          // surface from anywhere the scanner visited, including non-preset Library
          // subdirs and any custom quick-scan paths the user has added.
          const ok = allowedPrefixes.some(p => entry.path === p || entry.path.startsWith(p + '/'))
          if (!ok) continue
        }
        const isProtectedRootContentsOnly = isContentOnlyProtectedRoot(entry.path)
        if (isProtectedRootContentsOnly) continue

        if (isCleanable(entry) || isDev || isDownloadsItem || isTrashItem)
          result.set(entry.path, entry)
      }
    }
    return result
  }, [tree, quickScanAllowedPaths, rootPath, homeDir, platformInfo])

  const cleanableCount = allCleanable.size

  // Notify tray when a manual scan finishes
  // Use allCleanable so the value matches what Smart Clean's Caches & Temp section shows
  const allCleanableRef = useRef(allCleanable)
  allCleanableRef.current = allCleanable
  useEffect(() => {
    if (prevScanning.current && !scanning && rootPath) {
      let foundKB = 0
      for (const e of allCleanableRef.current.values()) foundKB += e.sizeKB
      window.electronAPI.notifyManualScanDone(foundKB)
    }
    prevScanning.current = scanning
  }, [scanning])

  // ── Panel drag handlers ────────────────────────────────────────────────────

  const handleWidthDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingWidth.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = panelWidth
  }, [panelWidth])

  const handleSplitDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingSplit.current = true
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingWidth.current) {
        const delta = dragStartX.current - e.clientX
        const next = Math.min(getPanelMaxWidth(), Math.max(MIN_PANEL_WIDTH, dragStartWidth.current + delta))
        setPanelWidth(next)
      }
      if (draggingSplit.current && rightPanelRef.current) {
        const rect = rightPanelRef.current.getBoundingClientRect()
        const ratio = (e.clientY - rect.top) / rect.height
        setSplitRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)))
      }
    }
    const onUp = () => {
      draggingWidth.current = false
      draggingSplit.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    const syncPanelWidthToViewport = () => {
      setPanelWidth((prev) => Math.max(MIN_PANEL_WIDTH, Math.min(getPanelMaxWidth(), prev)))
    }

    syncPanelWidthToViewport()
    window.addEventListener('resize', syncPanelWidthToViewport)
    return () => window.removeEventListener('resize', syncPanelWidthToViewport)
  }, [])

  // ── Scan ──────────────────────────────────────────────────────────────────

  const handleScan = useCallback((pathOverride?: string) => {
    const path = normalizeUiPath(pathOverride ?? (scanMode === 'quick' && QUICK_SCAN_PATH ? QUICK_SCAN_PATH : selectedPath))
    resetTo(path)
    setRootPath(path)
    setScanTrigger(t => t + 1)
    window.electronAPI.updateLastScanPath(path)
    setSelectedPaths(new Map())
    setConfirmedDeletedPaths(new Set())
    setContextMenu(null)
    setInfoPanelEntry(null)
    setSmartCleanOpen(false)
    setSavedLeftoverSelection(null)
  }, [scanMode, QUICK_SCAN_PATH, selectedPath, resetTo])

  /** Triggered by the Scan button on the welcome screen — animates controls out then starts scan. */
  const handleScanFromWelcome = useCallback(() => {
    const effectivePath = scanMode === 'quick' && QUICK_SCAN_PATH ? QUICK_SCAN_PATH : selectedPath
    setScanPhase('departing')
    setTimeout(() => {
      setScanPhase('active')
      handleScan(effectivePath)
    }, 320)
  }, [handleScan, scanMode, selectedPath, QUICK_SCAN_PATH])

  const handleChooseFolder = useCallback(async () => {
    const picked = await window.electronAPI.openDirectory()
    if (!picked) return
    const normalizedPicked = normalizeUiPath(picked)
    setSelectedPath(normalizedPicked)

    // If a scan has already completed, clear the previous results and return to
    // the empty/welcome view until the user starts the next scan.
    if (scanPhase === 'active' && !scanning) {
      setScanPhase('arriving')
      setRootPath(null)
      resetTo(normalizedPicked)
      setSelectedPaths(new Map())
      setContextMenu(null)
      setInfoPanelEntry(null)
      setSmartCleanOpen(false)
      setSavedLeftoverSelection(null)
      setReviewOpen(false)
    }
  }, [scanPhase, scanning, resetTo])

  const handleToggleScanMode = useCallback((mode: ScanMode) => {
    if (mode === scanMode) return
    setScanMode(mode)

    // Switching modes after a completed scan should return to the empty state
    // and require an explicit Scan click in the new mode.
    if (scanPhase === 'active' && !scanning) {
      setScanPhase('arriving')
      setRootPath(null)
      resetTo(selectedPath)
      setSelectedPaths(new Map())
      setContextMenu(null)
      setInfoPanelEntry(null)
      setSmartCleanOpen(false)
      setSavedLeftoverSelection(null)
      setReviewOpen(false)
    }
  }, [scanMode, scanPhase, scanning, resetTo, selectedPath])

  // ── Navigation ────────────────────────────────────────────────────────────

  const handleNavigate = useCallback(
    (entry: DiskEntry) => {
      if (entry.isDir) navigate(entry.path)
    },
    [navigate]
  )

  // ── Context menu ──────────────────────────────────────────────────────────

  const handleContextMenu = useCallback((entry: DiskEntry, x: number, y: number) => {
    setContextMenu({ entry, x, y })
  }, [])

  const handleRevealInFinder = useCallback(() => {
    if (!contextMenu) return
    window.electronAPI.revealInFileManager(contextMenu.entry.path)
  }, [contextMenu])

  const handleToggleSelect = useCallback(() => {
    if (!contextMenu) return
    const { entry } = contextMenu
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry)
      return next
    })
  }, [contextMenu])

  const handleSelectEntry = useCallback((entry: DiskEntry) => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry)
      return next
    })
  }, [])

  const handleInfo = useCallback(() => {
    if (!contextMenu) return
    setInfoPanelEntry(contextMenu.entry)
  }, [contextMenu])

  // ── Smart clean ───────────────────────────────────────────────────────────

  const handleSmartClean = useCallback(() => {
    setSmartCleanOpen(true)
  }, [])

  /** Called by SmartCleanPanel when the user clicks "Review" — replaces the current
   *  selection with SmartClean's curated set and closes the panel. */
  const handleSmartCleanReview = useCallback((entries: DiskEntry[]) => {
    setSelectedPaths(new Map(entries.map(e => [e.path, e])))
    setSmartCleanOpen(false)
  }, [])

  /** Select or deselect a batch of entries from the list panel. */
  const handleBatchToggle = useCallback((entries: DiskEntry[], select: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      for (const entry of entries) {
        if (select) next.set(entry.path, entry)
        else next.delete(entry.path)
      }
      return next
    })
  }, [])

  const handleOpenDeleteReview = useCallback(() => {
    setReviewOpen(true)
  }, [])

  // ── Trash ─────────────────────────────────────────────────────────────────

  /** Called by ReviewPanel after the user confirms. Trashes only the paths they kept selected. */
  const handleConfirmTrash = useCallback(async (paths: string[], totalKB: number) => {
    if (paths.length === 0) return null

    const deletedPathSet = new Set(paths)

    // Stream progress: update tree + selection as each file is confirmed deleted.
    let deletedCount = 0
    const unsubscribe = window.electronAPI.onTrashProgress(({ path: p, success }) => {
      if (success) {
        deletedCount++
        removeEntries([p])
        setSelectedPaths(prev => { const next = new Map(prev); next.delete(p); return next })
        setConfirmedDeletedPaths(prev => new Set([...prev, p]))
        setSavedLeftoverSelection(prev => {
          if (prev === null || !prev.has(p)) return prev
          const next = new Set(prev)
          next.delete(p)
          return next
        })
      }
    })

    const err = await window.electronAPI.trashEntries(paths)
    unsubscribe()

    // Notify only if at least some files were actually deleted.
    // confirmedDeletedPaths is intentionally NOT reset here — it persists until the next scan
    // so that stale tree entries (from batched IPC flushes or timing races) remain hidden.
    if (deletedCount > 0) {
      setSavedLeftoverSelection(prev => {
        if (prev === null) return prev
        const next = new Set(prev)
        let changed = false
        for (const p of deletedPathSet) {
          if (next.delete(p)) changed = true
        }
        return changed ? next : prev
      })
      window.electronAPI.notifyCleaned(totalKB)
    }

    return err
  }, [removeEntries])

  // Cmd+, opens settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setSettingsRequestedTab('general')
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onOpenSettingsTab((tab) => {
      setSettingsRequestedTab(tab)
      setSettingsOpen(true)
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onUpdaterStatus((event) => {
      if (event.type === 'update-available') {
        setUpdateToast({ version: event.version, downloaded: false })
        return
      }
      if (event.type === 'update-downloaded') {
        setUpdateToast({ version: event.version, downloaded: true })
        return
      }
      if (event.type === 'update-not-available' || event.type === 'error') {
        setUpdateToast((current) => (current?.downloaded ? current : null))
      }
    })
    return () => unsubscribe()
  }, [])

  const handleOpenUpdateSettings = useCallback(() => {
    setUpdateToast(null)
    setSettingsRequestedTab('general')
    setSettingsOpen(true)
  }, [])

  // Handle "Clean X GB" clicked from tray menu or notification
  useEffect(() => {
    window.electronAPI.onBgCleanRequested((entries) => {
      const preselected = showDevDeps
        ? entries
        : entries.filter((e) => !isDevDependency(e))
      setSelectedPaths(new Map(preselected.map(e => [e.path, e])))
      setReviewOpen(true)
      setScanPhase('active')
    })
    return () => window.electronAPI.removeBgCleanListeners()
  }, [showDevDeps])

  // ── Derived ───────────────────────────────────────────────────────────────

  const selectedEntries = [...selectedPaths.values()]
  const selectedPathsSet = useMemo(() => new Set(selectedPaths.keys()), [selectedPaths])
  // Only show the full-width bar outside the treemap view; inside the treemap
  // the compact bar lives at the bottom of the left panel.
  const showSelectionBar = selectedEntries.length > 0 && !smartCleanOpen && scanPhase !== 'active'

  // In quick scan, cleanable entries can span multiple roots (~/Library, ~/Downloads,
  // custom absolute paths). Use homeDir as the common ancestor so buildCleanableTree
  // can build correct relative paths for all of them. Fall back to rootPath in deep scan.
  const smartCleanRootPath = scanMode === 'quick' && homeDir ? homeDir : (rootPath ?? '/')

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      <Toolbar onSettingsOpen={() => {
        setSettingsRequestedTab(null)
        setSettingsOpen(true)
      }} />

      {scanPhase === 'active' && stack.length > 0 && (
        <div className="border-b border-white/5">
          <Breadcrumb stack={stack} onNavigate={goTo} />
        </div>
      )}

      {/* Main content row */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0">
          {scanPhase === 'active' ? (
            <TreemapView
              entries={currentEntries}
              scanning={scanning}
              scannedCount={scannedCount}
              scanningPath={rootPath ?? undefined}
              error={null}
              selectedPaths={selectedPathsSet}
              onNavigate={handleNavigate}
              onContextMenu={handleContextMenu}
              onToggleSelect={handleSelectEntry}
              onBatchToggle={handleBatchToggle}
              selectedEntries={selectedEntries}
              onDeselect={() => setSelectedPaths(new Map())}
              onContinue={handleOpenDeleteReview}
            />
          ) : (
            /* Welcome screen — visible until the first scan animates it away */
            <div className="flex flex-col items-center justify-center h-full select-none">
              {(() => {
                const isWelcomeLeaving = scanPhase === 'departing'
                const isWelcomeArriving = scanPhase === 'arriving'
                return (
              <div
                className="flex flex-col items-center gap-7 transition-all duration-300 ease-in"
                style={{
                  opacity: (isWelcomeLeaving || isWelcomeArriving) ? 0 : 1,
                  transform: (isWelcomeLeaving || isWelcomeArriving) ? 'translateY(28px)' : 'translateY(0)',
                }}
              >
                {/* Title + subtitle */}
                <div className="flex flex-col items-center gap-2">
                  <p className="text-2xl font-semibold tracking-tight text-zinc-200">Nerion</p>
                  <p className="text-sm text-zinc-500">
                    {scanMode === 'quick' ? 'Scan common cleanup locations.' : 'Select a folder and scan to see what\'s taking up space.'}
                  </p>
                </div>

                {/* Folder + action controls */}
                <div className="flex flex-col items-center gap-3">

                  {/* Mode toggle */}
                  <div className="flex items-center gap-0.5 bg-white/[0.05] rounded-lg p-0.5">
                    {(['quick', 'deep'] as ScanMode[]).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => handleToggleScanMode(mode)}
                        className={['px-4 py-1.5 rounded-md text-xs font-medium transition-colors capitalize', scanMode === mode ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'].join(' ')}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>

                  {/* Folder picker — deep mode only */}
                  {scanMode === 'deep' ? (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                      <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span className="text-xs text-zinc-400 font-mono truncate max-w-[200px]" title={selectedPath}>
                        {selectedPath === '/' ? 'root' : selectedPath}
                      </span>
                      <button
                        onClick={handleChooseFolder}
                        className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors ml-1 border-l border-white/10 pl-2"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                  <p className="text-xs text-zinc-600">
                    {quickScanFolders.length > 0
                      ? quickScanFolders.map(f => isAbsoluteUiPath(f) ? pathBasename(f) : f).join(' · ')
                      : 'No folders selected — configure in Settings'}
                  </p>
                  )}

                  <button
                    onClick={handleScanFromWelcome}
                    className="px-8 py-2 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-sm font-medium text-white transition-colors"
                  >
                    Scan
                  </button>
                </div>
              </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* Resizable right panel */}
        {panelVisible && (
          <>
            {/* Horizontal drag handle (left edge of panel) */}
            <div
              onMouseDown={handleWidthDragStart}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors border-l border-white/5"
            />

            <div
              ref={rightPanelRef}
              style={{ width: panelWidth }}
              className="shrink-0 flex flex-col h-full overflow-hidden"
            >
              {/* Info panel — always top slot; flex proportion changes when both are open */}
              {infoPanelEntry && (
                <div
                  className="min-h-0 overflow-hidden"
                  style={{ flex: bothOpen ? splitRatio : 1 }}
                >
                  <InfoPanel
                    entry={infoPanelEntry}
                    isSelected={selectedPaths.has(infoPanelEntry.path)}
                    isPremium={isPremium}
                    onClose={() => setInfoPanelEntry(null)}
                    onUpgrade={() => setUpgradeOpen(true)}
                    onToggleSelect={(entry) => {
                      setSelectedPaths((prev) => {
                        const next = new Map(prev)
                        if (next.has(entry.path)) next.delete(entry.path)
                        else next.set(entry.path, entry)
                        return next
                      })
                    }}
                  />
                </div>
              )}

              {/* Vertical drag handle — only when both are open */}
              {bothOpen && (
                <div
                  onMouseDown={handleSplitDragStart}
                  className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors border-t border-white/5"
                />
              )}

              {/* Smart Clean panel — always bottom slot */}
              {smartCleanOpen && (
                <div
                  className="min-h-0 overflow-hidden"
                  style={{ flex: bothOpen ? 1 - splitRatio : 1 }}
                >
                  <SmartCleanPanel
                    allCleanable={allCleanable}
                    fullTree={tree}
                    rootPath={smartCleanRootPath}
                    homeDir={homeDir}
                    autoSelectDevDependencies={showDevDeps}
                    onInfo={setInfoPanelEntry}
                    onRevealInFinder={(p) => window.electronAPI.revealInFileManager(p)}
                    onReview={handleSmartCleanReview}
                    initialLeftoverSelection={savedLeftoverSelection}
                    isPremium={isPremium}
                    onUpgrade={() => setUpgradeOpen(true)}
                    confirmedDeletedPaths={confirmedDeletedPaths}
                    onClose={(leftoverSel) => {
                      setSavedLeftoverSelection(leftoverSel)
                      setSmartCleanOpen(false)
                    }}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showSelectionBar && (
        <SelectionBar
          selectedEntries={selectedEntries}
          onDeselect={() => setSelectedPaths(new Map())}
          onContinue={handleOpenDeleteReview}
        />
      )}

      {reviewOpen && (
        <ReviewPanel
          entries={selectedEntries}
          isPremium={isPremium}
          remainingQuota={FREE_DELETE_LIMIT_PER_MONTH - deleteQuotaUsed}
          onConfirm={handleConfirmTrash}
          deleteImmediately={deleteImmediately}
          confirmedDeletedPaths={confirmedDeletedPaths}
          onCancel={() => setReviewOpen(false)}
          onDone={() => {
            setReviewOpen(false)
            setSmartCleanOpen(false)
            setSelectedPaths(new Map())
          }}
          onUpgradeClick={() => {
            setReviewOpen(false)
            setUpgradeOpen(true)
          }}
        />
      )}

      {scanPhase === 'active' && (
        <SlideUpBar>
          <BottomBar
            selectedPath={selectedPath}
            scanningPath={rootPath ?? undefined}
            scanning={scanning}
            scannedCount={scannedCount}
            cleanableCount={cleanableCount}
            scanMode={scanMode}
            quickScanFolders={quickScanFolders}
            isPremium={isPremium}
            onScan={() => handleScan()}
            onCancelScan={cancelScan}
            onChangeFolder={handleChooseFolder}
            onSmartClean={handleSmartClean}
            onToggleScanMode={handleToggleScanMode}
          />
        </SlideUpBar>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isDir={contextMenu.entry.isDir}
          isSelected={selectedPaths.has(contextMenu.entry.path)}
          isCritical={isCriticalPath(contextMenu.entry.path)}
          canSelect={!isCriticalPath(contextMenu.entry.path) || isContentOnlyProtectedRoot(contextMenu.entry.path)}
          onRevealInFinder={handleRevealInFinder}
          onToggleSelect={handleToggleSelect}
          onInfo={handleInfo}
          onClose={() => setContextMenu(null)}
        />
      )}

      {updateToast && (
        <div className="fixed top-4 right-4 z-[100] max-w-sm">
          <button
            onClick={handleOpenUpdateSettings}
            className="w-full rounded-xl border border-blue-500/30 bg-zinc-950/95 px-4 py-3 text-left shadow-2xl shadow-black/30 backdrop-blur-xl transition-colors hover:border-blue-400/50 hover:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">
                  {updateToast.downloaded ? 'Update ready to install' : 'Update available'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  {updateToast.downloaded
                    ? `Nerion ${updateToast.version} has been downloaded. Open Settings to restart and install it.`
                    : `Nerion ${updateToast.version} is downloading now. Open Settings to view the update progress.`}
                </p>
              </div>
              <div className="flex items-start gap-3 shrink-0">
                <span className="text-[11px] text-blue-400">
                  Open
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Dismiss update toast"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setUpdateToast(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    event.stopPropagation()
                    setUpdateToast(null)
                  }}
                  className="text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  ×
                </span>
              </div>
            </div>
          </button>
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => {
            setSettingsOpen(false)
            setSettingsRequestedTab(null)
          }}
          onDevDepsChange={setShowDevDeps}
          onDeleteModeChange={setDeleteImmediately}
          quickScanFolders={quickScanFolders}
          platformInfo={platformInfo}
          onQuickScanFoldersChange={setQuickScanFolders}
          isPremium={isPremium}
          license={license}
          onUpgrade={() => setUpgradeOpen(true)}
          onLicense={() => setLicenseOpen(true)}
          onWhatsNew={() => setWhatsNewOpen(true)}
          activeTabOverride={settingsRequestedTab}
        />
      )}

      {upgradeOpen && (
        <UpgradeModal
          onClose={() => setUpgradeOpen(false)}
          onActivate={() => {
            setUpgradeOpen(false)
            setTimeout(() => setLicenseOpen(true), MODAL_SWITCH_DELAY_MS)
          }}
        />
      )}
      {licenseOpen && (
        <LicenseModal
          license={license}
          onClose={() => setLicenseOpen(false)}
          onUpgrade={() => {
            setLicenseOpen(false)
            setTimeout(() => setUpgradeOpen(true), MODAL_SWITCH_DELAY_MS)
          }}
          onActivate={activate}
          onDeactivate={deactivate}
        />
      )}
      {whatsNewOpen && (
        <WhatsNewModal
          version={appVersion ?? undefined}
          onClose={() => {
            setWhatsNewOpen(false)
            // Mark this version as seen so auto-show doesn't trigger again until next update
            if (appVersion) localStorage.setItem('nerion:lastSeenWhatsNewVersion', appVersion)
          }}
        />
      )}
    </div>
  )
}
