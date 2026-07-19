/**
 * electron-vite injects ELECTRON_RENDERER_URL while running the development
 * server. The variable may also be inherited by a packaged app launched from
 * the same shell, where following it would load an unrelated development page
 * instead of the renderer bundled in app.asar.
 */
export function resolveDevelopmentRendererUrl(
  isPackaged: boolean,
  configuredUrl: string | undefined
): string | undefined {
  if (isPackaged) return undefined
  const url = configuredUrl?.trim()
  return url || undefined
}
