// jest-expo installs fetch lazily; initialize it before the test environment is torn down.
Reflect.get(globalThis, 'fetch');

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = (props) => React.createElement(View, { ...props, testID: props.testID ?? 'icon' });
  return new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === 'string' && key !== '__esModule' ? Icon : undefined),
    },
  );
});
