// Progressive enhancements for the panel. Every page works without this file.
(() => {
  function flashLabel(button, text) {
    const original = button.dataset.label ?? button.textContent;
    button.dataset.label = original;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      flashLabel(button, 'কপি হয়েছে ✓');
    } catch {
      flashLabel(button, 'কপি করা যায়নি');
    }
  }

  document.addEventListener('click', (event) => {
    const byId = event.target.closest('[data-copy]');
    if (byId) {
      const el = document.getElementById(byId.dataset.copy);
      if (el) copy(el.textContent, byId);
      return;
    }
    const byText = event.target.closest('[data-copy-text]');
    if (byText) copy(byText.dataset.copyText, byText);
  });

  // Confirmation before destructive form submissions.
  document.addEventListener('submit', (event) => {
    const message = event.target.dataset?.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // Auto-submit selects (e.g. choosing an app in the integration guide).
  document.addEventListener('change', (event) => {
    if (event.target.matches('select[data-autosubmit]')) event.target.form.submit();
  });

  // Tabs: without JS every panel is visible; with JS only the selected one.
  for (const group of document.querySelectorAll('[data-tabs]')) {
    const list = group.querySelector('.tab-list');
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    const panels = [...group.querySelectorAll('[role="tabpanel"]')];
    const select = (index) => {
      tabs.forEach((t, i) => {
        t.setAttribute('aria-selected', String(i === index));
        t.tabIndex = i === index ? 0 : -1;
      });
      panels.forEach((p, i) => { p.hidden = i !== index; });
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        select(next);
        tabs[next].focus();
      });
    });
    list.classList.add('ready');
    select(0);
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const BN = '০১২৩৪৫৬৭৮৯';
  const toBn = (n) => String(n).replace(/\d/g, (d) => BN[d]);

  // Show / hide password fields.
  for (const input of document.querySelectorAll('input[type="password"]:not([hidden])')) {
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pw-toggle';
    toggle.textContent = 'দেখান';
    toggle.setAttribute('aria-label', 'পাসওয়ার্ড দেখান');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'লুকান' : 'দেখান';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখান');
      input.focus();
    });
    wrap.appendChild(toggle);
  }

  // Count statistics up from zero (the server already rendered the final value).
  if (!reduceMotion) {
    for (const el of document.querySelectorAll('[data-count]')) {
      const target = Number(el.dataset.count);
      if (!Number.isFinite(target) || target <= 0) continue;
      const duration = Math.min(1200, 500 + target * 40);
      const start = performance.now();
      el.textContent = toBn(0);
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        el.textContent = toBn(Math.round(target * (1 - (1 - t) ** 3)));
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  // Top progress bar and button spinner while the next page loads.
  const startNavigation = () => document.body.classList.add('is-navigating');
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
    startNavigation();
  });
  document.addEventListener('submit', (event) => {
    // Runs after the confirm() handler above, so cancelled submissions are left alone.
    setTimeout(() => {
      if (event.defaultPrevented) return;
      const button = event.submitter ?? event.target.querySelector('[type="submit"]');
      if (button) {
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
      }
      startNavigation();
    }, 0);
  });
  // Coming back with the Back button restores the page from cache: clear the loading states.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    document.body.classList.remove('is-navigating');
    for (const b of document.querySelectorAll('.is-loading')) {
      b.classList.remove('is-loading');
      b.removeAttribute('aria-busy');
    }
  });
})();
