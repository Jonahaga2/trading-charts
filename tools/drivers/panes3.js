  ev(document.querySelector('[data-tf="5m"]'));
  setTimeout(()=>{
    ev(document.querySelector('#btn-indicators'));
    ['RSI','MACD','Volume','ADX / DMI'].forEach(pickInd);
    setTimeout(()=>ev(document.querySelector('[data-close-panel]')), 700);
  }, 7000);
