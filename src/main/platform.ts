import { accessSync, constants } from 'node:fs'
import * as path from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app, shell } from 'electron'
import { detectRuntimePlatform, getPlatformInfo, platformFromNode, type AppPlatform, type PlatformInfo } from '../shared/platform'

export function getAppPlatform(): AppPlatform {
  return platformFromNode(process.platform)
}

export function getPlatformMeta(): PlatformInfo {
  return getPlatformInfo(getAppPlatform())
}

export function getScannerBinaryName(platform = getAppPlatform()): string {
  return platform === 'windows' ? 'scanner-bin.exe' : 'scanner-bin'
}

export function resolveScannerBinaryPath(): string | null {
  const binaryName = getScannerBinaryName()
  const candidates = [
    is.dev
      ? path.join(process.cwd(), 'resources', binaryName)
      : path.join(process.resourcesPath, binaryName),
  ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // continue
    }
  }

  return null
}

export function revealInFileManager(filePath: string): void {
  shell.showItemInFolder(filePath)
}

export function getWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 820,
    minWidth: 700,
    minHeight: 500,
    show: false,
    titleBarStyle: getAppPlatform() === 'macos' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f0f',
  }
}

export function supportsDockVisibility(): boolean {
  return getAppPlatform() === 'macos'
}

export function hideDock(): void {
  if (supportsDockVisibility()) app.dock?.hide()
}

export function showDock(): void {
  if (supportsDockVisibility()) app.dock?.show()
}

export function shouldKeepAppAliveOnWindowClose(): boolean {
  return getAppPlatform() === 'macos'
}

export function supportsFullDiskAccess(): boolean {
  return getPlatformMeta().supportsFullDiskAccess
}

export function getRendererPlatformInfo(): PlatformInfo {
  return getPlatformInfo(detectRuntimePlatform())
}
