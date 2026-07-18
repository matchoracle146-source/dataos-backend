// This script generates package.json for all services
// Run: node scripts/init-packages.js

const fs = require('fs');
const path = require('path');

const BASE_DEPS = {
  "fastify": "^4.26.0",
  "@fastify/cors": "^8.5.0",
  "@fastify/helmet": "^11.1.1",
  "@fastify/jwt": "^8.0.0",
  "@fastify/rate-limit": "^9.1.0",
  "pg": "^8.11.3",
  "ioredis": "^5.3.2",
  "axios": "^1.6.7",
  "uuid": "^9.0.0",
  "zod": "^3.22.4",
  "dotenv": "^16.4.1"
};

const DEV_DEPS = {
  "nodemon": "^3.0.3",
  "jest": "^29.7.0",
  "supertest": "^6.3.4"
};

const services = [
  { name: "user",         port: 3002, extra: { "axios": "^1.6.7" } },
  { name: "telecom",      port: 3003, extra: {} },
  { name: "ai",           port: 3004, extra: {} },
  { name: "wallet",       port: 3005, extra: {} },
  { name: "rewards",      port: 3006, extra: {} },
  { name: "analytics",    port: 3007, extra: {} },
  { name: "forecasting",  port: 3008, extra: {} },
  { name: "notification", port: 3009, extra: { "axios": "^1.6.7" } },
  { name: "community",    port: 3010, extra: {} },
];

services.forEach(({ name, port, extra }) => {
  const pkg = {
    name: `@dataos/${name}-service`,
    version: "1.0.0",
    main: "src/index.js",
    scripts: {
      start: "node src/index.js",
      dev: `PORT=${port} nodemon src/index.js`,
      test: "jest --coverage --testEnvironment=node"
    },
    dependencies: { ...BASE_DEPS, ...extra },
    devDependencies: DEV_DEPS,
    jest: {
      testMatch: ["**/tests/**/*.test.js"],
      collectCoverageFrom: ["src/**/*.js"]
    }
  };

  const pkgPath = path.join(__dirname, '..', 'services', name, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log(`Created: services/${name}/package.json`);
  } else {
    console.log(`Exists:  services/${name}/package.json`);
  }
});

// Also create shared/package.json
const sharedPkg = {
  name: "@dataos/shared",
  version: "1.0.0",
  main: "utils/index.js",
  scripts: { test: "jest" },
  dependencies: {},
  devDependencies: DEV_DEPS
};
fs.writeFileSync(
  path.join(__dirname, '..', 'shared', 'package.json'),
  JSON.stringify(sharedPkg, null, 2)
);
console.log('Created: shared/package.json');
console.log('\nDone. Run: npm install from root to install all dependencies.');
