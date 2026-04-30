import { isContentOnlyProtectedRoot as sharedIsContentOnlyProtectedRoot, isCriticalPath as sharedIsCriticalPath } from '../../shared/policy'

export function isCriticalPath(itemPath: string): boolean {
  return sharedIsCriticalPath(itemPath)
}

export function isContentOnlyProtectedRoot(itemPath: string): boolean {
  return sharedIsContentOnlyProtectedRoot(itemPath)
}
