  ev(document.querySelector('[data-tf="1d"]'));
  // scroll in so only the most recent ~40 candles fill the pane
  setTimeout(()=>{
    const cells=document.querySelectorAll('.cell');
    const canvas=cells[0].querySelector('.pane-main canvas');
    for(let i=0;i<26;i++){
      canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:900,clientY:400,bubbles:true}));
    }
  }, 6000);
