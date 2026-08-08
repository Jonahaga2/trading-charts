  ev(document.querySelector('[data-tf="15m"]'));
  setTimeout(()=>{
    ev(document.querySelector('#btn-indicators'));
    ['EMA','VWAP','Supertrend','MACD','Volume'].forEach(pickInd);
    setTimeout(()=>ev(document.querySelector('[data-close-panel]')), 700);
  }, 7000);
