export function openAuthorizationWindow() {
  const authorizationWindow = window.open('about:blank', '_blank')
  if (!authorizationWindow) {
    throw new Error('Allow pop-ups for OpenComputer, then try again.')
  }
  authorizationWindow.opener = null
  authorizationWindow.document.title = 'Connecting · OpenComputer'
  authorizationWindow.document.body.textContent =
    'Opening secure authorization…'
  return authorizationWindow
}

export function navigateAuthorizationWindow(
  authorizationWindow: Window,
  authorizationUrl: string,
) {
  authorizationWindow.location.replace(authorizationUrl)
}

export async function launchAuthorizationWindow(
  authorizationUrl: () => Promise<string>,
) {
  const authorizationWindow = openAuthorizationWindow()
  try {
    navigateAuthorizationWindow(authorizationWindow, await authorizationUrl())
  } catch (error) {
    authorizationWindow.close()
    throw error
  }
}
