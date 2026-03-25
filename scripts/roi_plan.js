function parseArgs() {
    const args = process.argv.slice(2);
    const out = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--target-inr") out.targetInr = Number(args[++i]);
        if (args[i] === "--usd-inr") out.usdInr = Number(args[++i]);
    }
    return out;
}

function round(value, digits = 2) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

(() => {
    const args = parseArgs();
    const targetInr = Number.isFinite(args.targetInr) ? args.targetInr : 60000;
    const usdInr = Number.isFinite(args.usdInr) ? args.usdInr : 92.3;
    const targetUsd = targetInr / usdInr;
    const monthlyReturns = [1, 2, 3, 5, 8];

    console.log(JSON.stringify({
        targetInr,
        usdInr,
        targetUsd: round(targetUsd, 2),
        requiredCapitalUsd: monthlyReturns.map((pct) => ({
            assumedMonthlyReturnPct: pct,
            requiredCapitalUsd: round(targetUsd / (pct / 100), 2)
        }))
    }, null, 2));
})();
