/** Browser installation UI; it never reads or caches workout data. */
const installButton = document.getElementById('install-app');
const installDialog = document.getElementById('pwa-install-dialog');
const installNow = document.getElementById('pwa-install-now');
const offlineStatus = document.getElementById('pwa-offline-status');
const updateStatus = document.getElementById('pwa-update-status');
const standalone = window.matchMedia('(display-mode: standalone)');
let installed = standalone.matches || navigator.standalone === true;
let deferredPrompt = null;
let prompting = false;
let dialogOpener = null;

function syncInstallControls() {
  installButton.hidden = installed;
  installButton.disabled = prompting;
  installNow.hidden = installed || !deferredPrompt;
  installNow.disabled = prompting;
}

function showInstallInstructions() {
  if (installed || installDialog.open) return;
  dialogOpener = document.activeElement;
  installDialog.showModal();
  document.getElementById('pwa-close-install').focus();
}

function closeInstallInstructions() {
  if (installDialog.open) installDialog.close();
}

async function requestInstall() {
  if (installed || prompting) return;
  if (!deferredPrompt) {
    showInstallInstructions();
    return;
  }
  // A captured prompt is single-use and is invoked only from the user's click.
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompting = true;
  closeInstallInstructions();
  syncInstallControls();
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    showInstallInstructions();
  } finally {
    prompting = false;
    syncInstallControls();
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredPrompt = event;
  syncInstallControls();
});
window.addEventListener('appinstalled', () => {
  installed = true;
  deferredPrompt = null;
  closeInstallInstructions();
  syncInstallControls();
});
standalone.addEventListener('change', event => {
  installed = event.matches || navigator.standalone === true;
  if (installed) closeInstallInstructions();
  syncInstallControls();
});

installButton.addEventListener('click', requestInstall);
installNow.addEventListener('click', requestInstall);
document.getElementById('pwa-close-install').addEventListener('click', closeInstallInstructions);
document.getElementById('pwa-done-install').addEventListener('click', closeInstallInstructions);
// Native dialog keyboard handling provides Escape and a focus trap.
installDialog.addEventListener('close', () => {
  if (installDialog.open) return;
  if (dialogOpener?.isConnected && !dialogOpener.hidden) dialogOpener.focus();
  dialogOpener = null;
});

function syncConnectionStatus() {
  offlineStatus.hidden = navigator.onLine !== false;
}
window.addEventListener('offline', syncConnectionStatus);
window.addEventListener('online', syncConnectionStatus);
syncConnectionStatus();
syncInstallControls();

async function registerWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    const showWaitingUpdate = () => {
      updateStatus.hidden = !(registration.waiting && navigator.serviceWorker.controller);
    };
    showWaitingUpdate();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', showWaitingUpdate);
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      updateStatus.hidden = true;
    });
    // No skipWaiting message or automatic reload: an open workout form stays put.
  } catch {
    // Browser installation can still be supported without a worker. Network-only
    // logging remains intact when the optional generic offline page is unavailable.
  }
}

if (document.readyState === 'complete') registerWorker();
else window.addEventListener('load', registerWorker, {once: true});
