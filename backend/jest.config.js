/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\.(spec|e2e-spec)\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 120000,
  maxWorkers: 2,
};
