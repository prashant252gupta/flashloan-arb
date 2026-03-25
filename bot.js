require("dotenv").config();

const { runBot } = require("./src/index");

runBot().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
