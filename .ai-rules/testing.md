# Testing

Testing standards and conventions.

> **Current state:** No test framework is configured yet. These rules define the target conventions for when testing is introduced.

## Framework and Runner

- Use **Vitest** as the test framework and runner (fast, native ESM/TypeScript, Vite-compatible)
- Use **React Testing Library** for component tests
- Use **MSW (Mock Service Worker)** for mocking API calls in integration tests

## File Naming and Co-Location

- Test files live **next to the code they test**, not in a separate `__tests__/` directory
- Name test files with a `.test.ts` or `.test.tsx` suffix

```
src/lib/next-actions.ts
src/lib/next-actions.test.ts

src/components/ui/button.tsx
src/components/ui/button.test.tsx

netlify/functions/lib/responses.ts
netlify/functions/lib/responses.test.ts
```

## What to Test

### Always Test

- **Pure utility functions** — `generateNextActions()`, `resolvePrompt()`, `classifyError()`, `flowReducer()`
- **Reducers and state machines** — every action type in `flowReducer` gets at least one test
- **API response helpers** — `json()`, `errorResponse()`, `classifyError()` edge cases
- **Data transformations** — any function that takes input and returns transformed output
- **Edge cases** — empty arrays, null values, missing fields, boundary conditions

### Test Selectively

- **Components with complex logic** — conditional rendering, form validation, state transitions
- **API client functions** — mock the fetch layer, test error handling and response parsing
- **Backend handlers** — integration tests with mocked storage; verify routing, validation, and status codes

### Do Not Test

- **Simple pass-through components** — components that just render props without logic
- **Third-party library behavior** — trust that LangChain, Netlify Blobs, etc. work correctly
- **CSS/styling** — do not write tests for visual appearance
- **Implementation details** — test behavior, not internal state or method calls

## Mocking Philosophy

- **Mock at boundaries, not internals.** Mock `fetch`, `getStore`, and external API calls. Do not mock internal functions.
- **Prefer MSW over manual fetch mocks** for components that call `src/lib/api.ts`
- **Mock storage in backend tests** by mocking the storage module, not `@netlify/blobs` directly

```typescript
// Good — mock at the boundary
vi.mock("./lib/storage/projects", () => ({
  getProject: vi.fn().mockResolvedValue({ id: "1", name: "Test" }),
  listProjects: vi.fn().mockResolvedValue([]),
}));

// Bad — mock internal implementation
vi.mock("@netlify/blobs", () => ({ ... }));  // too deep
```

- **Never mock what you can create.** If a function takes a `Project` object, create a real one — don't mock it.

```typescript
// Good — real test data
const project: Project = {
  id: "test-1",
  name: "Test Project",
  description: "A test project",
  // ... fill all required fields
};

// Bad — partial mock that hides missing fields
const project = { id: "test-1" } as Project;
```

## Test Naming

Use descriptive `describe` + `it` blocks that read as sentences. Describe the behavior, not the implementation.

```typescript
// Good
describe("generateNextActions", () => {
  it("returns session next step as first action", () => { ... });
  it("suggests resume action when last session is older than 7 days", () => { ... });
  it("caps total actions at 3", () => { ... });
  it("returns empty array when no context is available", () => { ... });
});

// Bad
describe("generateNextActions", () => {
  it("works", () => { ... });
  it("test case 2", () => { ... });
  it("should return correct value", () => { ... });
});
```

## Coverage Expectations

- **Utility functions:** 90%+ line coverage
- **Reducers:** 100% — every action type tested
- **Backend handlers:** test each HTTP method and error path
- **Components:** focus on interaction and conditional rendering, not render output
- **Overall target:** 70% line coverage (aspirational, not blocking)

Do not pursue coverage for its own sake. Untested code is better than meaninglessly tested code.

## Test Structure

Follow **Arrange-Act-Assert**:

```typescript
it("creates a project with generated UUID", async () => {
  // Arrange
  const input = { name: "My Project", description: "Test" };

  // Act
  const result = await createProject(input);

  // Assert
  expect(result.id).toBeDefined();
  expect(result.name).toBe("My Project");
  expect(result.updatedAt).toBeDefined();
});
```

## Stack-Specific

- Configure Vitest to resolve the `@/` path alias (match `tsconfig.json` paths)
- Use `@testing-library/react` with `userEvent` (not `fireEvent`) for simulating user interactions
- For Netlify Function handlers, test by calling the exported default function directly with a constructed `Request` object
- Do not test LLM chain outputs for exact content — test structure, field presence, and error handling instead
