// Chart 1 to 1m, others left alone, then colours, then "Match chart 1".
// Every chart should end on 1m carrying the picked colours.
ev(document.querySelector('[data-layout="4"]'));
setTimeout(() => {
  const tf = document.querySelector('.cell .tf-select');
  if (!tf) { window.__err.push('NO PER-CHART INTERVAL CONTROL'); return; }
  tf.value = '1';
  tf.dispatchEvent(new Event('change', { bubbles: true }));

  ev(document.querySelector('#btn-settings'));
  const row = n => [...document.querySelectorAll('#settings-body .setting')]
    .find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === n);
  const set = (name, hex) => {
    const r = row(name);
    if (!r) { window.__err.push('MISSING COLOUR: ' + name); return; }
    const i = r.querySelector('input[type=color]');
    i.value = hex; i.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('Up', '#00A3FF');
  set('Down', '#FF8A00');
  set('Background', '#101820');
  set('Volume up', '#FFFF00');
  set('Volume down', '#FF00FF');
  // The embed ignores grid and axis colours, so offering them would be a lie.
  if (row('Grid')) window.__err.push('GRID PICKER STILL PRESENT (it cannot work)');

  setTimeout(() => {
    ev(document.querySelector('#panel-settings [data-close-panel]'));
    ev(document.querySelector('#btn-sync'));
    ev(document.querySelector('[data-sync="settings"]'));

    // A forced rebuild must hand every chart a complete configuration. This
    // catches the whole family of "the callback got an extra argument" bugs:
    // forEach(mountWidget) passes the index as the second parameter, which
    // silently builds each chart from a number instead of its config.
    setTimeout(() => {
      const frames = [...document.querySelectorAll('.chart-mount iframe')];
      const syms = [...document.querySelectorAll('.sym-input')].map(x => x.value);
      if (!frames.length) { window.__err.push('NO IFRAMES AFTER SYNC'); return; }
      frames.forEach((f, i) => {
        let j = null;
        try { j = JSON.parse(decodeURIComponent(f.src.split('#')[1] || '')); } catch (e) {}
        // Check keys tv.js does NOT default. symbol and interval are useless
        // here: the widget invents its own when handed nothing, so a chart
        // built from garbage still reports a plausible symbol.
        if (!j || !j.theme || !j.style) {
          window.__err.push('CHART ' + i + ' REBUILT WITHOUT CONFIG: ' + JSON.stringify(j));
        } else if (String(j.symbol).split(':').pop() !== syms[i]) {
          window.__err.push('CHART ' + i + ' SYMBOL DRIFTED: ' + j.symbol + ' vs ' + syms[i]);
        } else if (j.interval !== '1') {
          window.__err.push('CHART ' + i + ' DID NOT MATCH CHART 1: interval=' + j.interval);
        }
      });
    }, 1500);
  }, 900);
}, 2000);
