// Four charts, then turn Volume and the chart toolbar off from Settings.
// Both should show up as "1" in every widget's config.
ev(document.querySelector('[data-layout="4"]'));
ev(document.querySelector('#btn-settings'));
const row = n => [...document.querySelectorAll('#settings-body .setting')]
  .find(r => r.querySelector('label').textContent.trim().startsWith(n));
['Volume', 'Chart toolbar', 'Legend'].forEach(n => {
  const r = row(n);
  if (r) ev(r.querySelector('button')); else window.__err.push('MISSING SETTING: ' + n);
});
