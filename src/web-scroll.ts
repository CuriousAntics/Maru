// Static script only: never interpolate form content, account data or secrets here.
// One-shot per-tab state preserves same-page form actions without changing navigation.
export const dashboardScrollScript = `(() => {
  const key = 'maru-scroll-once';
  const forget = () => { try { sessionStorage.removeItem(key); } catch {} };
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const button = event.submitter;
    // Named controls (for example, buttons named "action" or inputs named "target")
    // mask HTMLFormElement properties. Read the actual attributes, not those properties.
    const destination = button?.getAttribute('formtarget') || form.getAttribute('target') || '_self';
    if (destination !== '_self') return;
    const target = new URL(button?.getAttribute('formaction') || form.getAttribute('action') || location.href, location.href);
    if (target.origin !== location.origin || target.pathname !== location.pathname && !target.pathname.startsWith(location.pathname + '/')) { forget(); return; }
    const anchor = button?.dataset.scrollAnchor;
    try { sessionStorage.setItem(key, JSON.stringify({path:location.pathname, y:scrollY, at:Date.now(), anchor:/^question-[0-9]+$/.test(anchor || '') ? anchor : null})); } catch {}
  });
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a[href]')) forget();
  });
  const restore = () => {
    let saved;
    try { const raw = sessionStorage.getItem(key); forget(); saved = raw ? JSON.parse(raw) : null; } catch { forget(); return; }
    if (!saved || saved.path !== location.pathname || !Number.isFinite(saved.y) || saved.y < 0 || saved.y > 20000000 || !Number.isFinite(saved.at) || Date.now() - saved.at < 0 || Date.now() - saved.at > 30000) return;
    requestAnimationFrame(() => {
      // Validation errors take priority so a failed save is never hidden off screen.
      const alert = document.querySelector('[role="alert"]');
      const anchor = typeof saved.anchor === 'string' && /^question-[0-9]+$/.test(saved.anchor) ? document.getElementById(saved.anchor) : null;
      if (alert) alert.scrollIntoView({block:'center',behavior:'instant'});
      else if (anchor) anchor.scrollIntoView({block:'start',behavior:'instant'});
      else window.scrollTo({top:saved.y,behavior:'instant'});
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore, {once:true});
  else restore();
})();`;
