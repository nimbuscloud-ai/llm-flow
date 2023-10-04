export default {
  clearMocks: true,
  moduleDirectories: ['node_modules'],
  modulePaths: ['<rootDir>'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  verbose: true,
  transform: {
    '^.+\\.(js|ts)?$': 'ts-jest',
  },
  roots: ['<rootDir>', '<rootDir>/test', '<rootDir>/src'],
  setupFiles: ['dotenv/config'],
};
