import { openSync, readSync, closeSync } from 'fs'
import { app, BrowserWindow, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { loadSettings, patchSettings } from './settings'
import { setQuitting } from './background'

/**
 * Returns 'universal', 'arm64', or 'x64' by reading the first 8 bytes of the
 * running Mach-O binary. No external tools required.
 *
 * Fat (universal) binary:  magic = 0xCAFEBABE  (big-endian, bytes 0-3)
 * Thin 64-bit binary:      magic = 0xFEEDFACF  (little-endian, bytes 0-3)
 *   CPU_TYPE_ARM64  = 0x0100000C  (bytes 4-7)
 *   CPU_TYPE_X86_64 = 0x01000007  (bytes 4-7)
 */
function detectBuildArch(): 'universal' | 'arm64' | 'x64' {
  if (process.platform === 'darwin') {
    try {
      const buf = Buffer.alloc(8)
      const fd = openSync(process.execPath, 'r')
      readSync(fd, buf, 0, 8, 0)
      closeSync(fd)

      if (buf.readUInt32BE(0) === 0xcafebabe) return 'universal'

      if (buf.readUInt32LE(0) === 0xfeedfacf) {
        const cpuType = buf.readUInt32LE(4)
        if (cpuType === 0x0100000c) return 'arm64'
        if (cpuType === 0x01000007) return 'x64'
      }
    } catch {
      // unreadable — fall through to process.arch
    }
  }
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

function getUpdateChannel(): string | null {
  if (process.platform === 'darwin') return detectBuildArch()
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'arm64' : 'x64'
  return null
}

let listenersRegistered = false
let checkInFlight = false
let downloadedUpdateReady = false
let autoUpdateSchedule: ReturnType<typeof setInterval> | null = null
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_POLL_MS = 60 * 60 * 1000

function showMainWindowForUpdate(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('open-settings-tab', 'general')
}

function showUpdateReadyNotification(version: string): void {
  if (!Notification.isSupported()) return

  const note = new Notification({
    title: 'Nerion update ready',
    body: `Version ${version} has been downloaded. Click to open Settings and restart to install.`,
  })
  note.on('click', () => showMainWindowForUpdate())
  note.show()
}

function shouldRunAutomaticCheck(): boolean {
  const settings = loadSettings()
  if (!settings.autoUpdateEnabled) return false
  if (!settings.lastAutoUpdateCheckTime) return true
  return Date.now() - settings.lastAutoUpdateCheckTime >= AUTO_UPDATE_INTERVAL_MS
}

export type UpdaterStatusEvent =
  | { type: 'checking' }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available'; version: string }
  | { type: 'download-progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

function broadcastUpdaterStatus(event: UpdaterStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater-status', event)
    }
  }
}

function compareSemver(a: string, b: string): number {
  const aParts = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10))
  const bParts = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10))
  const len = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(aParts[i]) ? aParts[i] : 0
    const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0
    if (av > bv) return 1
    if (av < bv) return -1
  }

  return 0
}
function ensureUpdaterListeners(): void {
  if (listenersRegistered) return

  autoUpdater.on('error', (err) => {
    downloadedUpdateReady = false
    const message = err instanceof Error ? err.message : String(err)
    broadcastUpdaterStatus({ type: 'error', message })
    console.error('[Nerion] Auto-updater error:', err)
  })

  autoUpdater.on('update-available', (info) => {
    broadcastUpdaterStatus({ type: 'update-available', version: info.version })
    console.log(`[Nerion] Update available: ${info.version}`)
  })

  autoUpdater.on('update-not-available', (info) => {
    downloadedUpdateReady = false
    broadcastUpdaterStatus({ type: 'update-not-available', version: info.version })
    console.log(`[Nerion] No update available (provider): ${info.version}`)
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdaterStatus({
      type: 'download-progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateReady = true
    broadcastUpdaterStatus({ type: 'update-downloaded', version: info.version })
    console.log(`[Nerion] Update downloaded: ${info.version}.`)
    showUpdateReadyNotification(info.version)
  })

  listenersRegistered = true
}

export async function runAutoUpdateCheck(reason: 'startup' | 'settings-enabled' | 'scheduled' | 'manual' = 'startup'): Promise<boolean> {
  if (!app.isPackaged) return false
  if (!['darwin', 'win32'].includes(process.platform)) return false

  const settings = loadSettings()
  if (reason !== 'manual' && !settings.autoUpdateEnabled) return false
  if (checkInFlight) return false
  if (reason !== 'manual' && reason !== 'settings-enabled' && !shouldRunAutomaticCheck()) return false

  checkInFlight = true
  try {
    if (reason !== 'manual') {
      patchSettings({ lastAutoUpdateCheckTime: Date.now() })
    }
    broadcastUpdaterStatus({ type: 'checking' })
    const currentVersion = app.getVersion()

    ensureUpdaterListeners()

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    const channel = getUpdateChannel()
    if (channel) autoUpdater.channel = channel
    downloadedUpdateReady = false

    console.log(`[Nerion] Auto-update check (${reason}): channel=${autoUpdater.channel ?? 'default'}, checking from ${currentVersion}.`)
    const result = await autoUpdater.checkForUpdates()
    const nextVersion = result?.updateInfo?.version
    if (!nextVersion || compareSemver(nextVersion, currentVersion) <= 0) {
      console.log(`[Nerion] Auto-update check (${reason}): already up to date (${currentVersion}).`)
      return false
    }

    console.log(`[Nerion] Auto-update check (${reason}): ${currentVersion} -> ${nextVersion}.`)
    return true
  } catch (err) {
    downloadedUpdateReady = false
    const message = err instanceof Error ? err.message : String(err)
    broadcastUpdaterStatus({ type: 'error', message })
    console.error('[Nerion] Auto-update check failed:', err)
    return false
  } finally {
    checkInFlight = false
  }
}

export function installDownloadedUpdateNow(): boolean {
  if (!downloadedUpdateReady) return false
  setQuitting()
  autoUpdater.quitAndInstall(false, true)
  return true
}

export function isUpdateReadyToInstall(): boolean {
  return downloadedUpdateReady
}

export function scheduleAutoUpdateChecks(): void {
  if (autoUpdateSchedule) clearInterval(autoUpdateSchedule)
  autoUpdateSchedule = setInterval(() => {
    runAutoUpdateCheck('scheduled').catch(() => {})
  }, AUTO_UPDATE_POLL_MS)
}
