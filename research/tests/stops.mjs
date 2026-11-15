const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const B = (exit = {}) => ({ feat: 'smoothMomR', bucket: 'large', top: 10, wfun: rankW, exit });
console.log('AGGRESSIVE: 100% stocks, weekly, rank weights. Stop = sell next open after a close below the line; back in at the next weekly pick.\n');
go('no stop (current aggressive)', B(), 'weekly', 1);
for (const s of [0.03, 0.05, 0.07, 0.10, 0.15]) go(`stop ${s * 100}% below buy price`, B({ type: 'x', stop: s }), 'weekly', 1);
for (const s of [0.05, 0.10, 0.15]) go(`trailing stop ${s * 100}% below the high`, B({ type: 'x', trail: s }), 'weekly', 1);
for (const m of [1.5, 2, 3]) go(`ATR stop ${m}x daily range`, B({ type: 'x', atrMult: m }), 'weekly', 1);
BUCKETS.large.cost = 0.001; console.log('\nwith double trading costs (0.1%):');
go('no stop', B(), 'weekly', 1); go('stop 5%', B({ type: 'x', stop: 0.05 }), 'weekly', 1); go('stop 10%', B({ type: 'x', stop: 0.10 }), 'weekly', 1); go('trailing 10%', B({ type: 'x', trail: 0.10 }), 'weekly', 1);
