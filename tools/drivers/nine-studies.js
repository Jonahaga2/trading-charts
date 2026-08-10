// Nine charts, then two indicators chosen once and expected on all nine.
ev(document.querySelector('[data-layout="9"]'));
ev(document.querySelector('#btn-studies'));
pickInd('VWAP');
pickInd('RSI');
ev(document.querySelector('#panel-studies [data-close-panel]'));
