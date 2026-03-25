require("dotenv").config();

const { runBot } = require("../src/index");

runBot({
    once: true,
    overrides: {
        ARB_ENABLE_PRIVATE_EXECUTION: "1",
        ARB_PRIVATE_EXECUTION_DRY_RUN: "1"
    }
}).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
