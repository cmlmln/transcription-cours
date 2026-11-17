// Garder l'écran allumé. iOS libère le Wake Lock dès que l'onglet est masqué :
// on le redemande à chaque retour au premier plan, et s'il est relâché tout seul.

export class WakeLockManager {
  constructor({ onChange = () => {}, onLog = () => {} } = {}) {
    this.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    this.lock = null;
    this.wanted = false;
    this.error = null;
    this.video = null;
    this.onChange = onChange;
    this.onLog = onLog;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted) this.acquire();
    });
  }

  get active() { return !!(this.lock && !this.lock.released) || !!(this.video && !this.video.paused); }

  async acquire() {
    this.wanted = true;
    if (!this.supported || this.active || document.visibilityState !== 'visible') { this.onChange(); return; }
    try {
      const lock = await navigator.wakeLock.request('screen');
      this.lock = lock;
      this.error = null;
      this.onLog('wakelock-actif');
      lock.addEventListener('release', () => {
        if (this.lock === lock) this.lock = null;
        this.onLog('wakelock-relache');
        this.onChange();
        // Relâché par le système alors qu'on est visible (ex. économie d'énergie) : on retente.
        if (this.wanted && document.visibilityState === 'visible') setTimeout(() => this.acquire(), 1000);
      });
    } catch (e) {
      this.error = e && e.message || String(e);
      this.onLog('wakelock-erreur', { message: this.error });
    }
    this.onChange();
  }

  release() {
    this.wanted = false;
    const l = this.lock;
    this.lock = null;
    if (l) l.release().catch(() => {});
    this.stopVideo();
    this.onChange();
  }

  // Option expérimentale, désactivée par défaut : une vidéo muette (sans piste son)
  // jouée en boucle empêche la mise en veille sur certains iOS. Peut perturber la
  // session audio d'iOS et donc la reconnaissance : à n'utiliser qu'en dernier recours.
  // Doit être lancée depuis un tap (lecture vidéo).
  startVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.src = 'media/veille.mp4';
      v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      v.className = 'veille-video';
      document.body.appendChild(v);
      this.video = v;
    }
    this.video.play().then(() => this.onLog('video-veille-active'), (e) => this.onLog('video-veille-erreur', { message: e.message }));
    this.onChange();
  }

  stopVideo() {
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; }
  }
}
