// Desktop modules call require('axios') directly; keep that export callable.
module.exports = require('./transport.js').default;
