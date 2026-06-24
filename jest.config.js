module.exports = {
  testMatch: ['**/tests/**/*.test.js'],
  testEnvironment: 'node',
  verbose: true,
  moduleNameMapper: {
    '^wx-server-sdk$': '<rootDir>/tests/mock-cloud.js',
  },
};
