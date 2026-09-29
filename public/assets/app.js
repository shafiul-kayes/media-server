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
})();
