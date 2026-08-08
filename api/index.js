const app = require('../index.js');

// Vercel expects default export for @vercel/node
module.exports = app;
module.exports.default = app;
