const { createRedisClient } = require('../../../shared/utils/redis-client');

const client = createRedisClient();

client.on('error', (err) => console.error('Redis error:', err));
client.on('connect', () => console.log('Redis connected'));

module.exports = { client };
