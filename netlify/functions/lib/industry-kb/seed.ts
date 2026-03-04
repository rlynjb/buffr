import { saveStandard, saveMeta, listMeta } from "../storage/industry-kb";
import type { IndustryStandard, IndustryKBMeta } from "../../../../src/lib/types";

const SEED_VERSION = "2026.03";

const SEED_DATA: Omit<IndustryStandard, "id" | "updatedAt">[] = [
  {
    technology: "react",
    version: SEED_VERSION,
    title: "React Best Practices",
    sections: [
      "Component Structure",
      "State Management",
      "Performance",
      "Testing",
      "Accessibility",
    ],
    content: `# React Best Practices

## Component Structure
- Prefer function components with hooks over class components
- Keep components small and focused — one responsibility per component
- Extract reusable logic into custom hooks
- Co-locate related files (component, styles, tests) in the same directory
- Use named exports for components (enables better refactoring tooling)
- Separate container/smart components from presentational/dumb components

## State Management
- Use \`useState\` for local component state
- Use \`useReducer\` for complex state with multiple sub-values
- Lift state to the nearest common ancestor — avoid prop drilling with Context
- Use React Context for truly global state (theme, auth, locale)
- Avoid putting everything in global state — prefer local state by default
- Derive computed values inline or with \`useMemo\` — don't store derived state

## Performance
- Memoize expensive computations with \`useMemo\`
- Memoize callbacks passed to child components with \`useCallback\`
- Use \`React.memo\` for components that render often with the same props
- Avoid creating new objects/arrays in render — stabilize references
- Use lazy loading (\`React.lazy\` + \`Suspense\`) for code splitting
- Profile with React DevTools before optimizing — measure, don't guess

## Testing
- Test behavior, not implementation details
- Use React Testing Library over Enzyme
- Write integration tests that render components with their context
- Test user interactions: clicks, typing, form submissions
- Mock API calls at the network layer (MSW) not at the module level
- Aim for high confidence, not high coverage

## Accessibility
- Use semantic HTML elements (\`button\`, \`nav\`, \`main\`, \`section\`)
- Add \`aria-label\` to icon-only buttons and links
- Ensure all interactive elements are keyboard accessible
- Manage focus when opening/closing modals and dialogs
- Use \`role\` attributes only when no semantic element exists
- Test with screen readers and keyboard-only navigation
`,
  },
  {
    technology: "nextjs",
    version: SEED_VERSION,
    title: "Next.js Best Practices",
    sections: [
      "App Router",
      "Data Fetching",
      "API Routes",
      "Performance",
      "Deployment",
    ],
    content: `# Next.js Best Practices

## App Router
- Use the App Router (\`app/\` directory) for new projects
- Organize routes with route groups \`(group)\` for shared layouts
- Use \`layout.tsx\` for persistent UI across route segments
- Use \`loading.tsx\` for route-level loading states
- Use \`error.tsx\` for route-level error boundaries
- Keep page components thin — delegate to feature components

## Data Fetching
- Fetch data in Server Components by default — no \`useEffect\` needed
- Use \`fetch\` with caching options for server-side data
- Deduplicate requests — Next.js automatically dedupes \`fetch\` calls
- Use \`generateStaticParams\` for static generation of dynamic routes
- Prefer server-side data fetching over client-side for SEO-critical pages
- Use SWR or TanStack Query for client-side data that needs real-time updates

## API Routes
- Use Route Handlers (\`route.ts\`) in the App Router
- Validate request bodies before processing
- Return consistent error shapes: \`{ error: string }\`
- Use appropriate HTTP status codes (400, 401, 404, 500)
- Add rate limiting for public endpoints
- Never expose secrets in client-side code

## Performance
- Use \`next/image\` for automatic image optimization
- Use \`next/font\` for self-hosted fonts with zero layout shift
- Minimize client-side JavaScript — prefer Server Components
- Use dynamic imports for heavy client-side libraries
- Configure \`headers()\` for proper cache-control
- Use \`generateMetadata\` for SEO metadata

## Deployment
- Use environment variables for configuration (\`.env.local\` for dev)
- Set up CI/CD with automated type-checking and linting
- Configure \`output: 'standalone'\` for containerized deployments
- Use ISR (Incremental Static Regeneration) for semi-static content
- Monitor Core Web Vitals in production
- Test with \`next build && next start\` before deploying
`,
  },
  {
    technology: "typescript",
    version: SEED_VERSION,
    title: "TypeScript Best Practices",
    sections: [
      "Type Safety",
      "Generics",
      "Utility Types",
      "Project Config",
      "Common Patterns",
    ],
    content: `# TypeScript Best Practices

## Type Safety
- Enable \`strict: true\` in tsconfig.json — non-negotiable for new projects
- Prefer \`interface\` for object shapes, \`type\` for unions and intersections
- Avoid \`any\` — use \`unknown\` when the type is truly unknown
- Use \`as const\` for literal type inference on objects and arrays
- Narrow types with type guards instead of type assertions
- Define return types for public API functions

## Generics
- Use generics when a function works with multiple types but maintains type relationships
- Constrain generics with \`extends\` to enforce minimum shape
- Prefer fewer generic parameters — complexity grows exponentially
- Name generic parameters descriptively when more than one: \`TInput\`, \`TOutput\`
- Use default generic parameters for common cases

## Utility Types
- Use \`Partial<T>\` for optional updates
- Use \`Required<T>\` to make all properties mandatory
- Use \`Pick<T, K>\` and \`Omit<T, K>\` to derive sub-types
- Use \`Record<K, V>\` for dictionaries
- Use \`ReturnType<T>\` to extract return types from functions
- Combine utility types: \`Partial<Pick<User, 'name' | 'email'>>\`

## Project Config
- Enable \`noUncheckedIndexedAccess\` for safer array/object access
- Enable \`noImplicitReturns\` to catch missing returns
- Enable \`exactOptionalPropertyTypes\` for precise optional handling
- Use path aliases (\`@/\`) for clean imports
- Keep \`lib\` and \`target\` aligned with your runtime
- Use project references for monorepo setups

## Common Patterns
- Use discriminated unions for state machines and variants
- Prefer \`readonly\` arrays and properties for immutable data
- Use template literal types for string patterns
- Define error types and use \`Result<T, E>\` pattern for fallible operations
- Export types alongside their implementations
- Use \`satisfies\` operator for type checking without widening
`,
  },
  {
    technology: "tailwind",
    version: SEED_VERSION,
    title: "Tailwind CSS Best Practices",
    sections: [
      "Configuration",
      "Component Patterns",
      "Responsive Design",
      "Dark Mode",
      "Performance",
    ],
    content: `# Tailwind CSS Best Practices

## Configuration
- Extend the default theme rather than overriding it
- Define design tokens (colors, spacing, fonts) in \`tailwind.config\`
- Use CSS variables for dynamic theming
- Configure \`content\` paths to include all template files
- Use Tailwind v4's \`@theme\` directive for inline configuration
- Keep custom utilities minimal — prefer composing existing classes

## Component Patterns
- Extract repeated class combinations into CSS components with \`@apply\`
- Use BEM naming for extracted CSS classes: \`.card\`, \`.card__title\`, \`.card--highlighted\`
- Co-locate component CSS files with their components
- Prefer utility classes for one-off styling
- Use \`@apply\` in separate CSS files, not inline styles
- Keep class lists readable — group by category (layout, spacing, color, typography)

## Responsive Design
- Design mobile-first — use \`sm:\`, \`md:\`, \`lg:\` for larger screens
- Use container queries (\`@container\`) for component-level responsiveness
- Avoid fixed widths — use \`max-w-\` constraints instead
- Test at common breakpoints: 375px, 768px, 1024px, 1440px
- Use \`gap\` over margins for flex/grid spacing
- Prefer \`grid\` for 2D layouts, \`flex\` for 1D layouts

## Dark Mode
- Use \`class\` strategy for manual dark mode control
- Define color pairs: light background + dark override
- Use semantic color names: \`bg-surface\`, \`text-primary\`
- Test contrast ratios in both modes (WCAG AA minimum)
- Use \`prefers-color-scheme\` media query as initial default

## Performance
- Enable JIT mode (default in v3+)
- Remove unused CSS with content configuration
- Avoid dynamically constructing class names: \`text-\${color}-500\` won't work
- Use \`@reference\` in separate CSS files to enable Tailwind v4 \`@apply\`
- Minimize custom CSS — every custom class is a potential maintenance burden
`,
  },
  {
    technology: "nodejs",
    version: SEED_VERSION,
    title: "Node.js Best Practices",
    sections: [
      "Project Structure",
      "Error Handling",
      "Security",
      "Performance",
      "Testing",
    ],
    content: `# Node.js Best Practices

## Project Structure
- Organize by feature/domain, not by type (routes, controllers, models)
- Keep entry points thin — delegate to modules
- Use ES modules (\`import/export\`) over CommonJS (\`require\`)
- Separate configuration from code — use environment variables
- Use a single \`lib/\` or \`src/\` directory for source code
- Keep serverless functions small and focused — one responsibility per function

## Error Handling
- Always handle promise rejections — use try/catch with async/await
- Create custom error classes for domain-specific errors
- Log errors with context (request ID, user ID, operation name)
- Return user-friendly error messages — never expose stack traces
- Use error classification to map internal errors to HTTP status codes
- Implement graceful shutdown for long-running processes

## Security
- Never commit secrets — use environment variables and \`.env\` files (gitignored)
- Validate and sanitize all user input at system boundaries
- Use parameterized queries — never interpolate user input into SQL/NoSQL queries
- Escape HTML when rendering user-provided content
- Set appropriate CORS headers — restrict origins in production
- Keep dependencies updated — run \`npm audit\` regularly
- Use helmet.js or equivalent for HTTP security headers

## Performance
- Use streaming for large payloads instead of buffering
- Implement caching at appropriate layers (memory, CDN, database)
- Use connection pooling for database and HTTP connections
- Avoid blocking the event loop — offload CPU-intensive work
- Monitor memory usage — watch for leaks in long-running processes
- Use compression for API responses

## Testing
- Write unit tests for pure business logic
- Write integration tests for API endpoints
- Use test databases or in-memory stores for isolation
- Mock external services at the HTTP boundary (MSW, nock)
- Test error paths — not just happy paths
- Use code coverage as a guide, not a goal
`,
  },
];

export async function seedIndustryKB(
  force = false
): Promise<{ seeded: string[]; skipped: string[] }> {
  const existingMeta = await listMeta();
  const existingMap = new Map(existingMeta.map((m) => [m.technology, m]));

  const seeded: string[] = [];
  const skipped: string[] = [];
  const now = new Date().toISOString();

  for (const entry of SEED_DATA) {
    const existing = existingMap.get(entry.technology);
    if (existing && !force) {
      skipped.push(entry.technology);
      continue;
    }

    const standard: IndustryStandard = {
      ...entry,
      id: entry.technology,
      updatedAt: now,
    };
    await saveStandard(standard);

    const meta: IndustryKBMeta = {
      technology: entry.technology,
      version: SEED_VERSION,
      lastSeeded: now,
      entryCount: 1,
    };
    await saveMeta(meta);
    seeded.push(entry.technology);
  }

  return { seeded, skipped };
}
