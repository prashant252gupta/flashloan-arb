const fs = require("fs");
const path = require("path");

function appendJsonLine(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(value) + "\n");
}

module.exports = {
    appendJsonLine
};
