(() => {
  const STATUS_URL = '/api/playground-update/status';
  const UPDATE_URL = '/api/playground-update';
  const BUTTON_CLASS = 'codexWebUpdateButton';
  const PHASE_LABELS = {
    download: '\u6b63\u5728\u4e0b\u8f7d\u4e0a\u6e38\u6e90\u7801',
    patch: '\u6b63\u5728\u5e94\u7528 Codex Web \u8865\u4e01',
    install: '\u6b63\u5728\u5b89\u88c5\u6784\u5efa\u4f9d\u8d56',
    test: '\u6b63\u5728\u8fd0\u884c\u4e0a\u6e38\u6d4b\u8bd5',
    build: '\u6b63\u5728\u6784\u5efa\u751f\u56fe\u5de5\u4f5c\u53f0',
    verify: '\u6b63\u5728\u6821\u9a8c\u5e76\u5207\u6362\u7248\u672c',
  };

  let status = null;
  let pollTimer = 0;
  let toastTimer = 0;
  let ensureFrame = 0;
  let reloadWhenIdleTimer = 0;
  let updateStartVersion = '';

  function createButton(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${BUTTON_CLASS} ${BUTTON_CLASS}--${kind}`;
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', '\u4e00\u952e\u66f4\u65b0\u751f\u56fe\u5de5\u4f5c\u53f0');
    button.title = '\u68c0\u67e5\u751f\u56fe\u5de5\u4f5c\u53f0\u66f4\u65b0';

    const icon = document.createElement('span');
    icon.className = 'codexWebUpdateIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u21bb';
    button.appendChild(icon);
    button.addEventListener('click', startUpdate);
    return button;
  }

  function ensureButtons() {
    ensureFrame = 0;
    const header = document.querySelector('header');
    const heading = header?.querySelector('h1');
    const brandRow = heading?.parentElement;
    if (brandRow && !brandRow.querySelector(`.${BUTTON_CLASS}--desktop`)) {
      const tools = [...brandRow.children].find((child) => child !== heading && child.tagName === 'DIV');
      if (tools) tools.prepend(createButton('desktop'));
    }

    const settings = header?.querySelector('button[aria-label="\u8bbe\u7f6e"]');
    const actions = settings?.parentElement?.parentElement;
    if (actions && !actions.querySelector(`.${BUTTON_CLASS}--mobile`)) {
      actions.prepend(createButton('mobile'));
    }
    applyStatus(status);
  }

  function scheduleEnsureButtons() {
    if (ensureFrame) return;
    ensureFrame = requestAnimationFrame(ensureButtons);
  }

  function applyStatus(next) {
    if (next) status = next;
    if (!status) return;
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      const state = status.status === 'updating'
        ? 'updating'
        : status.status === 'error'
          ? 'error'
          : status.updateAvailable
            ? 'available'
            : status.status === 'success'
              ? 'success'
              : 'idle';
      button.dataset.state = state;
      button.disabled = status.status === 'updating' || status.enabled === false;
      const icon = button.querySelector('.codexWebUpdateIcon');
      const iconText = state === 'success' ? '\u2713' : state === 'error' ? '!' : '\u21bb';
      if (icon.textContent !== iconText) icon.textContent = iconText;
      button.title = statusTitle(status);
      button.setAttribute('aria-label', statusTitle(status));
    }
  }

  function statusTitle(value) {
    if (value.enabled === false) return '\u751f\u56fe\u5de5\u4f5c\u53f0\u5728\u7ebf\u66f4\u65b0\u5df2\u7981\u7528';
    if (value.status === 'updating') return PHASE_LABELS[value.phase] || '\u6b63\u5728\u66f4\u65b0\u751f\u56fe\u5de5\u4f5c\u53f0';
    if (value.status === 'error') return `\u66f4\u65b0\u5931\u8d25\uff0c\u70b9\u51fb\u91cd\u8bd5\uff1a${value.error || '\u672a\u77e5\u9519\u8bef'}`;
    if (value.updateAvailable) return `\u4e00\u952e\u66f4\u65b0\uff1a${value.currentTag} \u2192 ${value.latestTag}`;
    return `\u5df2\u662f\u6700\u65b0\u7248\u672c ${value.currentTag || ''}`.trim();
  }

  async function readStatus() {
    try {
      const response = await fetch(STATUS_URL, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applyStatus(data);
      if (data.status === 'updating') schedulePoll();
    } catch (error) {
      applyStatus({
        enabled: true,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        updateAvailable: false,
      });
    }
  }

  async function startUpdate() {
    if (status?.status === 'updating') return;
    updateStartVersion = status?.currentVersion || '';
    applyStatus({ ...status, status: 'updating', phase: 'download', error: '' });
    showToast('\u6b63\u5728\u51c6\u5907\u66f4\u65b0\u2026', 'loading', true);
    try {
      const response = await fetch(UPDATE_URL, { method: 'POST', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applyStatus(data);
      if (data.status === 'updating') {
        showToast(PHASE_LABELS[data.phase] || data.message || '\u6b63\u5728\u66f4\u65b0\u2026', 'loading', true);
        schedulePoll();
      } else {
        finishUpdate(data);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyStatus({ ...status, status: 'error', error: message });
      showToast(`\u66f4\u65b0\u5931\u8d25\uff1a${message}`, 'error');
    }
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = window.setTimeout(pollUpdate, 1200);
  }

  async function pollUpdate() {
    pollTimer = 0;
    try {
      const response = await fetch(STATUS_URL, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applyStatus(data);
      if (data.status === 'updating') {
        showToast(PHASE_LABELS[data.phase] || data.message || '\u6b63\u5728\u66f4\u65b0\u2026', 'loading', true);
        schedulePoll();
        return;
      }
      finishUpdate(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyStatus({ ...status, status: 'error', error: message });
      showToast(`\u66f4\u65b0\u5931\u8d25\uff1a${message}`, 'error');
    }
  }

  function finishUpdate(data) {
    if (data.status === 'error') {
      showToast(`\u66f4\u65b0\u5931\u8d25\uff1a${data.error || '\u5df2\u7ee7\u7eed\u4f7f\u7528\u539f\u7248\u672c'}`, 'error');
      return;
    }
    const changed = Boolean(updateStartVersion && data.currentVersion && updateStartVersion !== data.currentVersion);
    showToast(data.message || '\u751f\u56fe\u5de5\u4f5c\u53f0\u5df2\u662f\u6700\u65b0\u7248\u672c', 'success');
    if (!changed) return;
    const generating = document.querySelector('button[aria-label="\u505c\u6b62\u751f\u6210"]');
    if (generating) {
      showToast('\u66f4\u65b0\u5df2\u5b8c\u6210\uff0c\u5f53\u524d\u4efb\u52a1\u7ed3\u675f\u540e\u5237\u65b0', 'success', true);
    }
    scheduleReloadWhenIdle();
  }

  function scheduleReloadWhenIdle() {
    if (reloadWhenIdleTimer) return;
    reloadWhenIdleTimer = window.setTimeout(reloadWhenGenerationEnds, 900);
  }

  function reloadWhenGenerationEnds() {
    reloadWhenIdleTimer = 0;
    if (document.querySelector('button[aria-label="\u505c\u6b62\u751f\u6210"]')) {
      scheduleReloadWhenIdle();
      return;
    }
    window.location.reload();
  }

  function showToast(message, tone, sticky = false) {
    let toast = document.querySelector('.codexWebUpdateToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'codexWebUpdateToast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.dataset.tone = tone;
    toast.textContent = message;
    toast.classList.add('visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    if (!sticky) {
      toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
    }
  }

  function init() {
    ensureButtons();
    window.setInterval(scheduleEnsureButtons, 1500);
    void readStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
