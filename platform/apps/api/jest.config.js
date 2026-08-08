// Jest for the API guard suites (08_ROAD_TO_10 §1.3).
//
// The rest of the monorepo runs vitest; apps/api runs Jest because the guard
// specs are written against Jest's API (`jest.fn()`) and @nestjs/testing's
// `Test.createTestingModule`, which is the Nest-idiomatic pairing. Keeping the
// two runners apart is fine — `pnpm -r test` calls each package's own `test`
// script, so nothing has to agree on a single runner.
//
// ts-jest compiles with apps/api/tsconfig.json, so `emitDecoratorMetadata` and
// `experimentalDecorators` are the same settings `nest build` uses. A guard
// compiled with different decorator settings from the one that ships would be
// a test of something that does not exist.
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  rootDir: "src",
  testEnvironment: "node",
  testMatch: ["**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
};
