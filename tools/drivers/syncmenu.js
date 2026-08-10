// Four charts, then open the Sync menu and check both actions are wired.
ev(document.querySelector('[data-layout="4"]'));
setTimeout(() => {
  ev(document.querySelector('#btn-sync'));
  const m = document.querySelector('#sync-menu');
  if (m.hidden) window.__err.push('MENU DID NOT OPEN');
  const items = [...m.querySelectorAll('[data-sync]')].map(b => b.dataset.sync);
  if (items.join(',') !== 'settings,symbol') window.__err.push('MENU ITEMS: ' + items.join(','));
  // clicking outside must close it
  ev(document.querySelector('#grid'));
  if (!m.hidden) window.__err.push('MENU DID NOT CLOSE ON OUTSIDE CLICK');
  // symbol sync should put the active chart's ticker on all four
  ev(document.querySelector('#btn-sync'));
  ev(m.querySelector('[data-sync="symbol"]'));
}, 1500);
