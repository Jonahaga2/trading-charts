// Nine charts, an indicator on all of them, then borderless.
ev(document.querySelector('[data-layout="9"]'));
ev(document.querySelector('#btn-studies'));
pickInd('VWAP');
ev(document.querySelector('#panel-studies [data-close-panel]'));
setTimeout(() => {
  ev(document.querySelector('#btn-focus'));
  if (document.body.dataset.focus !== '1') window.__err.push('FOCUS DID NOT ENGAGE');
  if (getComputedStyle(document.querySelector('#header')).display !== 'none') window.__err.push('HEADER STILL VISIBLE');
  if (document.querySelector('.cell-bar') && getComputedStyle(document.querySelector('.cell-bar')).display !== 'none') window.__err.push('CELL BAR STILL VISIBLE');
  if (getComputedStyle(document.querySelector('#focus-exit')).display === 'none') window.__err.push('NO WAY OUT');
}, 1500);
