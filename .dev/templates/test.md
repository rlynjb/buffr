```jsx
import { render, screen } from '@testing-library/react';
import MyComponent from './MyComponent';

test('renders hello world message', () => {
  render(<MyComponent />);
  const messageElement = screen.getByText(/Hello, World!/i);
  expect(messageElement).toBeInTheDocument();
});
```