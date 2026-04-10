import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export interface BackgroundScanSettings {
  enabled: boolean
  intervalHours: number
  scanTimeHour: number   // 0–23, hour of day to run the scan
  lastScanPath: string | null
  lastScanTime: number | null
  lastScanResults: Array<{ path: string; name: string; sizeKB: number; isDir: boolean }>
}

export interface VectraSettings {
  backgroundScan: BackgroundScanSettings
  showMenuBarIcon: boolean
  preferredOllamaModel: string | null
  onboardingComplete: boolean
  showDevDependencies: boolean
  /** Folder names (relative to ~/Library) included in Quick Scan mode. */
  quickScanFolders: string[]
  /** Absolute paths the user has added via the folder picker. */
  customQuickScanFolders: string[]
  lastManualScanTime: number | null
  lastManualScanFoundKB: number
  lastCleanedTime: number | null
  lastCleanedKB: number
}

const DEFAULTS: VectraSettings = {
  backgroundScan: {
    enabled: false,
    intervalHours: 168,
    scanTimeHour: 2,
    lastScanPath: null,
    lastScanTime: null,
    lastScanResults: []
  },
  showMenuBarIcon: true,
  preferredOllamaModel: null,
  onboardingComplete: false,
  showDevDependencies: false,
  quickScanFolders: ['Caches', 'Logs', 'Developer', 'Containers', 'Downloads'],
  customQuickScanFolders: [],
  lastManualScanTime: null,
  lastManualScanFoundKB: 0,
  lastCleanedTime: null,
  lastCleanedKB: 0
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): VectraSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<VectraSettings>
    return {
      ...DEFAULTS,
      ...parsed,
      backgroundScan: { ...DEFAULTS.backgroundScan, ...parsed.backgroundScan }
    }
  } catch {
    return { ...DEFAULTS, backgroundScan: { ...DEFAULTS.backgroundScan } }
  }
}

export function saveSettings(next: VectraSettings): void {
  const p = settingsPath()
  const dir = join(p, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
}

export function patchSettings(patch: Partial<VectraSettings>): VectraSettings {
  const current = loadSettings()
  const next: VectraSettings = {
    ...current,
    ...patch,
    backgroundScan: { ...current.backgroundScan, ...(patch.backgroundScan ?? {}) }
  }
  saveSettings(next)
  return next
}
