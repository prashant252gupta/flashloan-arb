const axios = require("axios");

async function postJson(url, body, options = {}) {
    const response = await axios.post(url, body, {
        timeout: options.timeoutMs || 15000,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });
    return response.data;
}

module.exports = {
    postJson
};
