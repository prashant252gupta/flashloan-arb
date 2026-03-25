function round(value, digits = 2) {
    if (!Number.isFinite(value)) return value;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function fmtUsd(value) {
    return `$${round(value, 2).toFixed(2)}`;
}

function fmtBps(value) {
    return `${round(value, 2).toFixed(2)}bps`;
}

module.exports = {
    round,
    fmtUsd,
    fmtBps
};
