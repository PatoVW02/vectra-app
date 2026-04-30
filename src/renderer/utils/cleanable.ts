import { DiskEntry } from '../types'
import {
  isAppleMetadata as sharedIsAppleMetadata,
  isCleanable as sharedIsCleanable,
  isDevDependency as sharedIsDevDependency,
} from '../../shared/policy'

export function isAppleMetadata(entry: DiskEntry): boolean {
  return sharedIsAppleMetadata(entry)
}

export function isCleanable(entry: DiskEntry): boolean {
  return sharedIsCleanable(entry)
}

export function isDevDependency(entry: DiskEntry): boolean {
  return sharedIsDevDependency(entry)
}
