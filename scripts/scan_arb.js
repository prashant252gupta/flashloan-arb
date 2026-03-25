require("dotenv").config();

const { runBot } = require("../src/index");

runBot({ once: true, overrides: { ARB_RECORD_CANDIDATES: "0" } }).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
