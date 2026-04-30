import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { getAppPlatform, resolveScannerBinaryPath } from './platform'

export interface DiskEntry {
  name: string
  path: string
  sizeKB: number
  isDir: boolean
}

// Parse native scanner output: "<sizeBytes>\t<d|f>\t<path>"
function parseScannerLine(line: string, rootPath: string): DiskEntry | null {
  const t1 = line.indexOf('\t')
  if (t1 === -1) return null
  const t2 = line.indexOf('\t', t1 + 1)
  if (t2 === -1) return null

  const sizeBytes = parseInt(line.slice(0, t1), 10)
  const isDir = line[t1 + 1] === 'd'
  const fullPath = line.slice(t2 + 1).replace(/\r$/, '')

  if (!fullPath || isNaN(sizeBytes)) return null
  // Skip the root itself
  if (fullPath === rootPath) return null

  return {
    name: path.basename(fullPath),
    path: fullPath,
    sizeKB: Math.round(sizeBytes / 1024),
    isDir
  }
}

// Parse du fallback output: "<sizeKB>\t<path>" (directories only, full tree)
function parseDuLine(line: string, rootPath: string): DiskEntry | null {
  const tabIndex = line.indexOf('\t')
  if (tabIndex === -1) return null

  const sizeKB = parseInt(line.slice(0, tabIndex).trim(), 10)
  const fullPath = line.slice(tabIndex + 1).trim()

  if (!fullPath || isNaN(sizeKB)) return null
  if (fullPath === rootPath) return null

  return {
    name: path.basename(fullPath),
    path: fullPath,
    sizeKB,
    isDir: true // du only outputs directories
  }
}

function spawnNativeScanner(
  binary: string,
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void,
  lowPriority = false
): () => void {
  // Wrap with `nice -n 10` in low-priority mode to reduce CPU/IO pressure
  const cmd = lowPriority ? 'nice' : binary
  const args = lowPriority ? ['-n', '10', binary, dirPath] : [dirPath]
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let buffer = ''
  let cancelled = false

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const entry = parseScannerLine(line, dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
  })

  proc.on('close', () => {
    if (buffer.trim()) {
      const entry = parseScannerLine(buffer.trim(), dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
    if (!cancelled) onDone()
  })

  proc.on('error', (err) => {
    if (!cancelled) onDone(err.message)
  })

  return () => {
    cancelled = true
    proc.kill()
  }
}

function spawnDuFallback(
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void,
  lowPriority = false
): () => void {
  // Full recursive scan — no depth limit, directories only
  const cmd = lowPriority ? 'nice' : 'du'
  const args = lowPriority ? ['-n', '10', 'du', '-k', dirPath] : ['-k', dirPath]
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let buffer = ''
  let cancelled = false

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = parseDuLine(line, dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
  })

  proc.on('close', () => {
    if (buffer.trim()) {
      const entry = parseDuLine(buffer.trim(), dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
    if (!cancelled) onDone()
  })

  proc.on('error', (err) => {
    if (!cancelled) onDone(err.message)
  })

  return () => {
    cancelled = true
    proc.kill()
  }
}

export function scanDirectoryStreaming(
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void,
  options?: { lowPriority?: boolean }
): () => void {
  const low = options?.lowPriority ?? false
  const binary = resolveScannerBinaryPath()
  if (binary) {
    return spawnNativeScanner(binary, dirPath, onEntry, onDone, low)
  }
  if (getAppPlatform() === 'macos') {
    return spawnDuFallback(dirPath, onEntry, onDone, low)
  }
  queueMicrotask(() => onDone('Native scanner binary not found'))
  return () => {}
}
