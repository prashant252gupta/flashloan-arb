const { appendJsonLine } = require("../lib/jsonl");

function createCandidateLogger(config) {
    return {
        log(report) {
            if (!config.recordCandidates) return;
            appendJsonLine(config.candidateLogPath, report);
        }
    };
}

module.exports = {
    createCandidateLogger
};
