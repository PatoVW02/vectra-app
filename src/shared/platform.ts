export type AppPlatform = 'macos' | 'windows'

export interface QuickScanOption {
  name: string
  desc: string
}

export interface PlatformInfo {
  id: AppPlatform
  fileManagerName: string
  revealActionLabel: string
  startupLabel: string
  startupDescription: string
  trayLabel: string
  trayDescription: string
  supportsFullDiskAccess: boolean
  fullDiskAccessLabel: string
  fullDiskAccessDescription: string
  notificationSettingsUrl: string | null
  fullDiskAccessSettingsUrl: string | null
  quickScanDefaults: string[]
  quickScanOptions: QuickScanOption[]
}

const MAC_QUICK_SCAN_OPTIONS: QuickScanOption[] = [
  { name: 'Caches', desc: 'App cache files' },
  { name: 'Logs', desc: 'App log files' },
  { name: 'Developer', desc: 'Xcode DerivedData & dev tool caches' },
  { name: 'Containers', desc: 'App sandbox containers' },
  { name: 'Downloads', desc: '~/Downloads folder' },
  { name: 'Desktop', desc: '~/Desktop folder' },
  { name: 'Trash', desc: '~/.Trash folder' },
  { name: 'Application Support', desc: 'Persistent app data' },
  { name: 'Saved Application State', desc: 'Saved window & app states' },
  { name: 'Group Containers', desc: 'Shared app group containers' },
]

const WINDOWS_QUICK_SCAN_OPTIONS: QuickScanOption[] = [
  { name: 'Temp', desc: 'Temporary files' },
  { name: 'Logs', desc: 'App and tool log folders' },
  { name: 'Downloads', desc: 'Downloads folder' },
  { name: 'Desktop', desc: 'Desktop folder' },
  { name: 'Recycle Bin', desc: 'Recycle Bin contents' },
  { name: 'AppData Local Temp', desc: 'Local app temp data' },
  { name: 'AppData Local Packages', desc: 'Store app caches and packages' },
  { name: 'AppData Roaming', desc: 'Roaming app data' },
]

const PLATFORM_INFO: Record<AppPlatform, PlatformInfo> = {
  macos: {
    id: 'macos',
    fileManagerName: 'Finder',
    revealActionLabel: 'Reveal in Finder',
    startupLabel: 'Open at startup',
    startupDescription: 'Launch Nerion silently in the background when your Mac starts so background scans can run without opening the app.',
    trayLabel: 'Menu Bar',
    trayDescription: 'Display the Nerion icon in the macOS menu bar for quick access and scan status.',
    supportsFullDiskAccess: true,
    fullDiskAccessLabel: 'Full Disk Access',
    fullDiskAccessDescription: 'Required to scan and clean all folders',
    notificationSettingsUrl: 'x-apple.systempreferences:com.apple.preference.notifications',
    fullDiskAccessSettingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    quickScanDefaults: ['Caches', 'Logs', 'Developer', 'Containers', 'Downloads', 'Desktop', 'Trash'],
    quickScanOptions: MAC_QUICK_SCAN_OPTIONS,
  },
  windows: {
    id: 'windows',
    fileManagerName: 'Explorer',
    revealActionLabel: 'Show in Explorer',
    startupLabel: 'Open at startup',
    startupDescription: 'Launch Nerion in the background when Windows starts so background scans can run without opening the app.',
    trayLabel: 'System Tray',
    trayDescription: 'Display the Nerion icon in the Windows system tray for quick access and scan status.',
    supportsFullDiskAccess: false,
    fullDiskAccessLabel: 'File access',
    fullDiskAccessDescription: 'Windows does not require a separate Full Disk Access permission for standard scans.',
    notificationSettingsUrl: 'ms-settings:notifications',
    fullDiskAccessSettingsUrl: null,
    quickScanDefaults: ['Temp', 'Logs', 'Downloads', 'Desktop'],
    quickScanOptions: WINDOWS_QUICK_SCAN_OPTIONS,
  },
}

export function platformFromNode(nodePlatform: string): AppPlatform {
  return nodePlatform === 'win32' ? 'windows' : 'macos'
}

export function detectRuntimePlatform(): AppPlatform {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (globalThis as any)?.process?.platform
    if (typeof p === 'string') return platformFromNode(p)
  } catch {
    // ignore
  }

  if (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)) {
    return 'windows'
  }

  return 'macos'
}

export function getPlatformInfo(platform: AppPlatform = detectRuntimePlatform()): PlatformInfo {
  return PLATFORM_INFO[platform]
}
