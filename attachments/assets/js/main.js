// Zanka Group — shared front-end behaviour

document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav toggle
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('block');
      menu.classList.toggle('hidden');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  // Scroll-triggered fade-in (Services page anchor sections, .reveal-on-scroll)
  const revealEls = document.querySelectorAll('.reveal-on-scroll');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (revealEls.length) {
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach(el => el.classList.add('is-visible'));
    } else {
      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
      revealEls.forEach(el => revealObserver.observe(el));
    }
  }

  // Footer year
  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = new Date().getFullYear();
  });

  // Resources / Insights filter tabs
  const tabs = document.querySelectorAll('[data-filter-tab]');
  const cards = document.querySelectorAll('[data-category]');
  if (tabs.length && cards.length) {
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('bg-navy', 'text-white'));
        tabs.forEach(t => t.classList.add('bg-white', 'text-navy'));
        tab.classList.add('bg-navy', 'text-white');
        tab.classList.remove('bg-white', 'text-navy');
        const filter = tab.getAttribute('data-filter-tab');
        cards.forEach(card => {
          if (filter === 'All' || card.getAttribute('data-category') === filter) {
            card.classList.remove('hidden');
          } else {
            card.classList.add('hidden');
          }
        });
      });
    });
  }

  // FAQ accordion
  document.querySelectorAll('[data-faq-trigger]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.nextElementSibling;
      const icon = btn.querySelector('[data-faq-icon]');
      const isOpen = panel.style.maxHeight;
      document.querySelectorAll('[data-faq-panel]').forEach(p => p.style.maxHeight = null);
      document.querySelectorAll('[data-faq-icon]').forEach(i => i.style.transform = 'rotate(0deg)');
      if (!isOpen) {
        panel.style.maxHeight = panel.scrollHeight + 'px';
        if (icon) icon.style.transform = 'rotate(45deg)';
      }
    });
  });

  // Generic contact / lead form: no backend wired up yet, show confirmation
  document.querySelectorAll('form[data-static-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const note = form.querySelector('[data-form-note]');
      if (note) {
        note.classList.remove('hidden');
        form.reset();
      }
    });
  });
});
