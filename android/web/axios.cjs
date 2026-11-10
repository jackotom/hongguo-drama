// Desktop modules call require('axios') directly; keep that export callable.
module.exports = require('./transport.js').default;
module.exports.post = require('../mobile/axios.cjs').post;
