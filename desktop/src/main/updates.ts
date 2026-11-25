// The app's own updates (spec section 24.1): electron-updater, from the feed
// electron-builder writes into the app (`publish` in electron-builder.yml).
// Only a packaged app updates, and macOS takes an update only into a build
// signed with a Developer ID.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const EVERY_MS = 4 * 60 * 60_000

export function startUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', () => {
    // No feed, offline, or an unsigned build: the app runs as it is.
  })
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  check()
  setInterval(check, EVERY_MS)
}
