console.log('All 100% stocks unless noted. Averaged over rebalance-day starts.\n');
go('PLAN (50/30/20 with old-runner rule)', T(), 'monthly', 0.5);
go('momentum only, top 10, monthly', T());
console.log('\n1) Trade more often (fresh signal):');
go('top 10, 2x a month', T(), '2x a month'); go('top 10, weekly', T(), 'weekly');
go('top 5, monthly', T({ top: 5 })); go('top 5, 2x a month', T({ top: 5 }), '2x a month'); go('top 5, weekly', T({ top: 5 }), 'weekly');
console.log('\n2) Shorter momentum windows:');
for (const f of ['s9R', 's6R', 's3R']) { go(`${f} top10 monthly`, T({ feat: f })); go(`${f} top10 weekly`, T({ feat: f }), 'weekly'); }
console.log('\n3) Bigger pool / mid-size stocks:');
go('top 10 of 1000 most-traded', T({ bucket: 'top1000' })); go('top 10 of mid-size (300-1000)', T({ bucket: 'mid1000' }));
go('top 10 of 1000, weekly', T({ bucket: 'top1000' }), 'weekly');
console.log('\n4) Costs doubled on the best weekly one:');
BUCKETS.large.cost = 0.001; go('top 10 weekly, 0.1% cost', T(), 'weekly'); go('top 5 weekly, 0.1% cost', T({ top: 5 }), 'weekly');
BUCKETS.large.cost = 0.0005;
